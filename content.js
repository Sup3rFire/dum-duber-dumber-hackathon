// Content script: find prose blocks, send them to the background worker to be
// transformed in the current MODE, and swap them in place. Reversible: switching
// back to "off" restores the originals.
//
// The per-site setting is a MODE string, not a boolean:
//   "off" | "crap" | "decrap"
// Legacy stored values are folded in for back-compat: the old boolean `true`
// and the old 5-stop keys ("decrap-mild"/"decrap-extreme"/"crap-mild"/
// "crap-extreme") map onto "decrap"/"crap".
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

  // ---------- per-site content scoping ----------
  // Some sites are mostly chrome (nav, meta, suggestions) with real prose only
  // in specific regions. On those, we ONLY transform blocks that live inside one
  // of the `include` containers — everything else is left exactly as-is.
  // LinkedIn class names below are the stable BEM-style ones (not the hashed
  // utility classes), covering feed post bodies, comment bodies, and job posts.
  const SITE_SCOPES = [
    {
      match: /(^|\.)linkedin\.com$/i,
      include: [
        // --- current LinkedIn (Feb 2026+): CSS-in-JS, hashed classes, so the
        //     stable hooks are data-* attributes, not classes. ---
        '[data-testid="expandable-text-box"]', // post / comment body text
        '[data-view-name="feed-commentary"]', // post body wrapper
        '[data-view-name*="commentary"]', // comment-commentary etc. (loose catch)
        // --- legacy markup fallbacks (older LinkedIn / cached surfaces) ---
        ".update-components-text", // post / comment body (legacy)
        ".feed-shared-text", // post body (legacy)
        ".feed-shared-inline-show-more-text", // "…see more" expanded body (legacy)
        ".comments-comment-item__main-content", // comment body (legacy)
        ".comments-comment-entity__content", // comment body (legacy)
        ".jobs-description__content", // job listing description
        ".jobs-box__html-content", // job listing description (inner html)
        ".jobs-description-content__text", // job listing description (variant)
        ".jobs-description__container", // job listing description (container)
      ],
    },
  ];

  const SCOPE = SITE_SCOPES.find((s) => s.match.test(HOST)) || null;
  const SCOPE_SEL = SCOPE ? SCOPE.include.join(",") : null;
  if (SCOPE_SEL) log("scoped site — only transforming:", SCOPE_SEL);

  // On a scoped site, a block only qualifies if it sits inside an allowed region.
  function inScope(el) {
    if (!SCOPE_SEL) return true;
    return !!(el.closest && el.closest(SCOPE_SEL));
  }

  let mode = "off"; // current per-site mode
  let active = false; // derived: mode !== "off"
  let writing = false; // true while we mutate the DOM, to ignore our own mutations
  let pageCounted = false; // ensures "pages processed" only increments once per activation
  let observer = null;
  let rescanTimer = null;

  // Normalize whatever is stored for this host into a current mode string,
  // folding in the legacy boolean and old 5-stop keys.
  function normalizeMode(v) {
    if (v === true) return "decrap"; // legacy boolean
    if (typeof v === "string") {
      if (v.startsWith("decrap")) return "decrap";
      if (v.startsWith("crap")) return "crap";
    }
    return "off";
  }

  const originals = new Map(); // element -> original innerHTML (for restore)

  // Virtualized feeds (LinkedIn) re-mount nodes on scroll, so the DOM MARK is an
  // unreliable "already done" signal. These content-side caches make re-encounters
  // cheap and correct. All three are cleared on mode change (so switching modes
  // legitimately re-transforms everything).
  const resultCache = new Map(); // `${mode}\u0000${originalText}` -> transformed text
  const producedOutputs = new Set(); // every transformed string we've written (to skip our own output)
  const countedOriginals = new Set(); // `${mode}\u0000${originalText}` already tallied into stats

  const rkey = (text) => mode + "\u0000" + text;

  function clearCaches() {
    resultCache.clear();
    producedOutputs.clear();
    countedOriginals.clear();
  }

  // ---------- helpers ----------
  // Canonical newline form: \n only, at most one blank line between paragraphs.
  // Used both when rendering output and when caching it, so a re-read of our own
  // DOM (innerText turns <br> back into \n) matches what we stored.
  const normalizeText = (t) =>
    t.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n");

  function wordCount(text) {
    const t = text.trim();
    return t ? t.split(/\s+/).length : 0;
  }

  // Short one-line preview of a block, for logging.
  function preview(text, n = 80) {
    const t = (text || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  }

  function isVisible(el) {
    return el.getClientRects().length > 0;
  }

  // Cheap length gate — textContent avoids the layout reflow that innerText forces.
  function tlen(el) {
    const t = el.textContent;
    return t ? t.trim().length : 0;
  }

  // "…see more" / "…more" toggles that sites inject into truncated posts. We
  // strip these so their label never ends up inside the text we transform.
  const EXPAND_SEL = [
    '[data-testid="expandable-text-button"]', // LinkedIn (Feb 2026+ SDUI)
    ".feed-shared-inline-show-more-text__see-more-less-toggle", // LinkedIn legacy
    ".lt-line-clamp__more",
    ".lt-line-clamp__less",
    ".see-more",
    ".see-less",
  ].join(",");

  // Full text of a block, INCLUDING any part hidden behind a "…see more" clamp.
  // innerText can stop at the truncation point; textContent has the whole post,
  // so when a block carries an expand toggle we read a cleaned clone instead
  // (toggle removed, <br> turned back into newlines). Otherwise innerText is
  // preferred — it preserves spacing between block elements that textContent drops.
  function fullText(el) {
    if (!(el.querySelector && el.querySelector(EXPAND_SEL))) {
      return (el.innerText || "").trim();
    }
    const clone = el.cloneNode(true);
    clone.querySelectorAll(EXPAND_SEL).forEach((n) => n.remove());
    clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    return (clone.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
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
      if (!inScope(el)) continue; // scoped site: skip anything outside content regions
      if (tlen(el) < MIN_CHARS) continue;
      if (hasQualifyingChild(el)) continue; // not the minimal block
      if (!isVisible(el)) continue;
      if (fullText(el).length < MIN_CHARS) continue; // accurate check (counts hidden "see more" text)
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
  // Write transformed text into an element while PRESERVING paragraph/line
  // breaks. `textContent = next` alone would drop them: the browser collapses
  // runs of whitespace (newlines included) down to a single rendered space, so
  // multi-paragraph output — crapify in particular is deliberately long and
  // multi-paragraph — flattens into one wall of text. Rendering each newline as
  // a <br> keeps the spacing regardless of the site's white-space CSS. Restore
  // is unaffected: we snapshot innerHTML before writing and put it back verbatim.
  function setBlockText(el, text) {
    if (!text.includes("\n")) {
      el.textContent = text; // single paragraph — fast path, no <br> needed
      return;
    }
    el.textContent = "";
    text.split("\n").forEach((line, i) => {
      if (i > 0) el.appendChild(document.createElement("br"));
      if (line) el.appendChild(document.createTextNode(line));
    });
  }

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

  // Apply a list of { b, next, cached } swaps in a single write pass. `cached`
  // marks a re-application from the content cache (no model call happened), so we
  // can log it quietly and never count it toward stats a second time.
  function applySwaps(pairs) {
    let wordsCut = 0; // words removed (decrapify shrinks)
    let wordsAdded = 0; // words added (crapify grows)
    let swapped = 0;

    withWriteGuard(() => {
      for (const { b, next: rawNext, cached } of pairs) {
        if (rawNext == null) {
          log("· no result — left original:", preview(b.text));
          continue; // failed/omitted — leave original
        }
        const next = normalizeText(rawNext);
        if (next.trim() === b.text.trim()) {
          // model left it as-is (already honest / not really prose); mark it.
          if (!cached) log("· unchanged by model:", preview(b.text));
          b.el.setAttribute(MARK, "1");
          continue;
        }

        originals.set(b.el, b.el.innerHTML);
        b.el.setAttribute(MARK, "1");
        setBlockText(b.el, next);
        swapped++;

        // Remember it so re-mounted copies are handled locally, and so we never
        // feed our own output back through the model.
        resultCache.set(rkey(b.text), next);
        producedOutputs.add(next.trim());

        const key = rkey(b.text);
        if (countedOriginals.has(key)) {
          log("· re-applied from cache (" + mode + "):", preview(next));
        } else {
          countedOriginals.add(key);
          const delta = wordCount(next) - wordCount(b.text);
          if (delta < 0) wordsCut += -delta;
          else wordsAdded += delta;
          // Full before -> after, so you can see exactly what GPT returned.
          log(
            "· swap (" + mode + "):",
            "\n  BEFORE:",
            b.text,
            "\n  AFTER :",
            next
          );
        }
      }
    });

    if (swapped) log("applied", swapped, "swap(s)");
    if (wordsCut > 0 || wordsAdded > 0) {
      browser.runtime
        .sendMessage({ type: "addStats", wordsCut, wordsAdded })
        .catch(() => {});
    }
  }

  // Adapter for a model response batch: map ids back to blocks, then apply.
  function applyResults(batch, results) {
    const byId = new Map(results.map((r) => [String(r.id), r.text]));
    applySwaps(batch.map((b, i) => ({ b, next: byId.get("b" + i) })));
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
    if (SCOPE_SEL) {
      log("scoped regions on page:", document.querySelectorAll(SCOPE_SEL).length);
    }
    log("scan found", els.length, "block(s)");
    if (!els.length) return;

    if (!pageCounted) {
      pageCounted = true;
      browser.runtime.sendMessage({ type: "addStats", pages: 1 }).catch(() => {});
    }

    // Build blocks, then partition into ones we can resolve locally (already seen
    // this session — the common case when scrolling a virtualized feed re-mounts
    // old posts) vs genuinely new blocks that must go to the model.
    const seen = els.map((el) => ({ el, text: fullText(el) }));

    const localPairs = []; // resolved from cache / already our output
    const blocks = []; // need a model call
    for (const b of seen) {
      if (producedOutputs.has(b.text.trim())) {
        // This node already shows one of our outputs (its MARK was lost on
        // re-mount). Leave the text, just re-mark it — never re-transform.
        localPairs.push({ b, next: b.text, cached: true });
        continue;
      }
      const hit = resultCache.get(rkey(b.text));
      if (hit != null) {
        localPairs.push({ b, next: hit, cached: true });
        continue;
      }
      blocks.push(b);
    }

    if (localPairs.length) {
      log("resolved", localPairs.length, "block(s) locally (no model call)");
      applySwaps(localPairs);
    }

    if (!blocks.length) return;

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
  // originals) before applying the new one, so e.g. decrap -> crap starts from
  // clean source text rather than re-transforming already-changed DOM.
  function applyMode(next) {
    const norm = normalizeMode(next);
    if (norm === mode) return;
    log("mode change:", mode, "->", norm, "on", HOST);

    if (active) {
      active = false;
      stopObserver();
      restoreAll();
    }

    // Caches are per-mode: drop them so the new mode re-transforms from scratch.
    clearCaches();

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
