// Content script: find bloated prose blocks, send them to the background worker
// for compression, and swap them in place. Reversible when toggled OFF.
// Runs on every page (see manifest <all_urls>) but stays dormant until the
// current site is switched ON in the popup.

(function () {
  const MIN_CHARS = 150; // minimum block length to bother compressing
  const BATCH_SIZE = 6; // blocks per OpenAI request
  const CONCURRENCY = 3; // max in-flight requests
  const MAX_BLOCKS = 100; // safety cap per scan
  const MARK = "data-ctc"; // marks a processed element
  const RESCAN_DEBOUNCE = 400; // ms to coalesce MutationObserver bursts

  const HOST = location.hostname;

  const DEBUG = true; // set false to silence
  const log = (...a) => DEBUG && console.log("%c[CTC]", "color:#911eb4", ...a);
  log("content script loaded on", HOST);

  // Where prose actually tends to live.
  const CANDIDATE_SEL =
    "p,li,blockquote,h1,h2,h3,h4,h5,h6,dd,figcaption,div,span,article,section";

  // Never touch these (or anything inside them).
  const EXCLUDE_CLOSEST =
    "pre,code,kbd,samp,nav,textarea,[contenteditable],[contenteditable='true']";
  const EXCLUDE_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION",
    "CODE",
    "PRE",
    "KBD",
    "SAMP",
  ]);

  let active = false;
  let writing = false; // true while we mutate the DOM, to ignore our own mutations
  let pageCounted = false; // ensures "pages processed" only increments once per activation
  let observer = null;
  let rescanTimer = null;

  const originals = new Map(); // element -> original innerHTML (for restore)

  // ---------- helpers ----------
  function wordCount(text) {
    const t = text.trim();
    return t ? t.split(/\s+/).length : 0;
  }

  function isVisible(el) {
    return el.getClientRects().length > 0;
  }

  // Cheap length gate — textContent avoids the layout reflow that innerText forces.
  function tlen(el) {
    const t = el.textContent;
    return t ? t.trim().length : 0;
  }

  function isExcluded(el) {
    if (EXCLUDE_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute(MARK)) return true;
    if (el.closest && el.closest(EXCLUDE_CLOSEST)) return true;
    return false;
  }

  // A "qualifying" child means this element isn't the smallest block that clears
  // the threshold — we should descend to that child instead. This is what lets a
  // container of many short paragraphs get caught as ONE block (Reddit-style),
  // while a container of long paragraphs is left to its individual paragraphs.
  function hasQualifyingChild(el) {
    for (const c of el.children) {
      if (!isExcluded(c) && tlen(c) >= MIN_CHARS) return true;
    }
    return false;
  }

  // Collect the smallest qualifying blocks, descending into open shadow roots
  // (modern Reddit, YouTube, etc. render content inside web components).
  function collectFrom(root, out) {
    const nodes = root.querySelectorAll(CANDIDATE_SEL);
    for (const el of nodes) {
      if (out.length >= MAX_BLOCKS) return;
      if (isExcluded(el)) continue;
      if (tlen(el) < MIN_CHARS) continue;
      if (hasQualifyingChild(el)) continue; // not the minimal block
      if (!isVisible(el)) continue;
      if ((el.innerText || "").trim().length < MIN_CHARS) continue; // accurate check
      out.push(el);
    }
    // Recurse into shadow roots.
    const all = root.querySelectorAll("*");
    for (const host of all) {
      if (host.shadowRoot) collectFrom(host.shadowRoot, out);
    }
  }

  function collectBlocks() {
    const found = [];
    collectFrom(document, found);
    return found;
  }

  // ---------- concurrency pool ----------
  async function runPool(items, limit, worker) {
    let i = 0;
    const runners = new Array(Math.min(limit, items.length))
      .fill(0)
      .map(async () => {
        while (i < items.length) {
          const idx = i++;
          await worker(items[idx]);
        }
      });
    await Promise.all(runners);
  }

  // ---------- swap / restore ----------
  function withWriteGuard(fn) {
    writing = true;
    if (observer) observer.disconnect();
    try {
      fn();
    } finally {
      if (observer && active) observer.observe(document.body, OBS_OPTS);
      writing = false;
    }
  }

  function applyResults(batch, results) {
    // batch: [{ id, el, text }], results: [{ id, text }]
    const byId = new Map(results.map((r) => [r.id, r.text]));
    let wordsBefore = 0;
    let wordsAfter = 0;

    withWriteGuard(() => {
      for (const b of batch) {
        const compressed = byId.get(b.id);
        if (compressed == null) continue; // failed/omitted — leave original
        if (compressed.trim() === b.text.trim()) {
          // model judged it already honest; mark so we don't retry it
          b.el.setAttribute(MARK, "1");
          continue;
        }
        originals.set(b.el, b.el.innerHTML);
        b.el.setAttribute(MARK, "1");
        b.el.textContent = compressed;
        wordsBefore += wordCount(b.text);
        wordsAfter += wordCount(compressed);
      }
    });

    if (wordsBefore > 0) {
      browser.runtime
        .sendMessage({ type: "addStats", wordsBefore, wordsAfter })
        .catch(() => {});
    }
  }

  function restoreAll() {
    withWriteGuard(() => {
      for (const [el, html] of originals) {
        el.innerHTML = html;
        el.removeAttribute(MARK);
      }
      originals.clear();
      // also unmark blocks that were "already honest"
      document.querySelectorAll("[" + MARK + "]").forEach((el) => {
        el.removeAttribute(MARK);
      });
    });
  }

  // ---------- main scan ----------
  async function scan() {
    if (!active) return;
    const els = collectBlocks();
    log("scan found", els.length, "block(s)");
    if (!els.length) return;

    if (!pageCounted) {
      pageCounted = true;
      browser.runtime.sendMessage({ type: "addStats", pages: 1 }).catch(() => {});
    }

    // Build blocks with stable ids, chunk into batches.
    const blocks = els.map((el, i) => ({
      id: String(i) + ":" + Math.random().toString(36).slice(2, 8),
      el,
      text: (el.innerText || "").trim(),
    }));

    const batches = [];
    for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
      batches.push(blocks.slice(i, i + BATCH_SIZE));
    }

    await runPool(batches, CONCURRENCY, async (batch) => {
      if (!active) return;
      try {
        const resp = await browser.runtime.sendMessage({
          type: "compress",
          blocks: batch.map((b) => ({ id: b.id, text: b.text })),
        });
        log("compress response:", resp);
        if (!resp) return;
        if (resp.error === "NO_API_KEY") {
          log("NO API KEY set — open Settings and add your OpenAI key");
          active = false; // nothing we can do without a key
          return;
        }
        if (resp.error) log("batch error from background:", resp.error);
        if (resp.results) applyResults(batch, resp.results);
      } catch (e) {
        log("sendMessage failed for a batch:", e);
      }
    });
  }

  function scheduleRescan() {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      scan();
    }, RESCAN_DEBOUNCE);
  }

  // ---------- observer ----------
  const OBS_OPTS = { childList: true, subtree: true, characterData: true };

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver((mutations) => {
      if (!active || writing) return;
      for (const m of mutations) {
        if (m.addedNodes.length || m.type === "characterData") {
          scheduleRescan();
          break;
        }
      }
    });
    observer.observe(document.body, OBS_OPTS);
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (rescanTimer) {
      clearTimeout(rescanTimer);
      rescanTimer = null;
    }
  }

  // ---------- activation ----------
  function activate() {
    if (active) return;
    log("activating on", HOST);
    active = true;
    pageCounted = false;
    startObserver();
    scan();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    stopObserver();
    restoreAll();
  }

  async function readSiteState() {
    const s = await browser.storage.local.get("siteState");
    const state = s.siteState || {};
    return state[HOST] === true;
  }

  async function init() {
    const on = await readSiteState();
    log("init — site toggled", on ? "ON" : "OFF", "for", HOST);
    if (on) activate();
  }

  // React to popup toggles for this host.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.siteState) return;
    const on = (changes.siteState.newValue || {})[HOST] === true;
    if (on) activate();
    else deactivate();
  });

  init();
})();
