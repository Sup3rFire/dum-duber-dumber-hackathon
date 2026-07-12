// Content script: find prose blocks, send them to the background worker to be
// transformed in the current MODE, and swap them in place. Reversible: switching
// back to "off" restores the originals.
//
// The per-site setting is now a MODE string, not a boolean:
//   "off" | "decrap-mild" | "decrap-extreme" | "crap-mild" | "crap-extreme"
// (a legacy boolean `true` is read as "decrap-extreme" for back-compat.)
// Runs on every page (see manifest <all_urls>) but stays dormant on "off".

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

  let mode = "off"; // current per-site mode
  let active = false; // derived: mode !== "off"
  let writing = false; // true while we mutate the DOM, to ignore our own mutations
  let pageCounted = false; // ensures "pages processed" only increments once per activation
  let observer = null;
  let rescanTimer = null;

  // Normalize whatever is stored for this host into a mode string.
  function normalizeMode(v) {
    if (v === true) return "decrap-extreme"; // legacy boolean
    if (typeof v === "string" && v !== "off") return v;
    return "off";
  }

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
    // results: [{ id, text }] with id = "b<index-within-batch>"
    const byId = new Map(results.map((r) => [String(r.id), r.text]));
    let wordsCut = 0; // words removed (decrapify shrinks)
    let wordsAdded = 0; // words added (crapify grows)
    let swapped = 0;

    withWriteGuard(() => {
      batch.forEach((b, i) => {
        const next = byId.get("b" + i);
        if (next == null) return; // failed/omitted — leave original
        if (next.trim() === b.text.trim()) {
          // model left it as-is (already honest / not really prose); mark so we
          // don't retry it, but keep no restore entry.
          b.el.setAttribute(MARK, "1");
          return;
        }
        originals.set(b.el, b.el.innerHTML);
        b.el.setAttribute(MARK, "1");
        b.el.textContent = next;
        const delta = wordCount(next) - wordCount(b.text);
        if (delta < 0) wordsCut += -delta;
        else wordsAdded += delta;
        swapped++;
      });
    });

    log("applied", swapped, "swap(s)");
    if (wordsCut > 0 || wordsAdded > 0) {
      browser.runtime
        .sendMessage({ type: "addStats", wordsCut, wordsAdded })
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

    // Build blocks, chunk into batches. Ids are assigned per-batch at send time.
    const blocks = els.map((el) => ({
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
          mode,
          blocks: batch.map((b, i) => ({ id: "b" + i, text: b.text })),
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

  // ---------- mode transitions ----------
  // Switching mode always tears down the previous transformation (restoring the
  // originals) before applying the new one, so e.g. decrap-mild -> crap-extreme
  // starts from clean source text rather than re-transforming already-changed DOM.
  function applyMode(next) {
    const norm = normalizeMode(next);
    if (norm === mode) return;
    log("mode change:", mode, "->", norm, "on", HOST);

    if (active) {
      active = false;
      stopObserver();
      restoreAll();
    }

    mode = norm;
    active = mode !== "off";

    if (active) {
      pageCounted = false;
      startObserver();
      scan();
    }
  }

  async function readSiteMode() {
    const s = await browser.storage.local.get("siteState");
    const state = s.siteState || {};
    return normalizeMode(state[HOST]);
  }

  async function init() {
    const m = await readSiteMode();
    log("init — mode", m, "for", HOST);
    applyMode(m);
  }

  // React to popup changes for this host.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.siteState) return;
    applyMode((changes.siteState.newValue || {})[HOST]);
  });

  init();
})();
