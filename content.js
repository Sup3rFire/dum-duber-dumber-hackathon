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

  // While a block is in flight to the model we replace it with an on-brand
  // "cooking" placeholder so the wait doesn't look like nothing is happening.
  const LOADING_CLASS = "ctc-cooking";
  const LOADING_LABEL = {
    crap: "🍳 piling on the crap",
    decrap: "🔪 cutting the crap",
  };

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

  const originals = new Map(); // element -> restore snapshot { html } | { text }

  // Virtualized feeds (Reddit, LinkedIn) unmount/re-mount nodes on scroll, so the
  // DOM MARK is an unreliable "already done" signal — a re-mounted node is a fresh
  // element showing the site's ORIGINAL text again. These content-side caches make
  // re-encounters free (no network) and, crucially, are keyed off a whitespace-
  // normalized fingerprint so the same text never looks "new" just because a re-
  // render shifted its whitespace (or because we read our own <br>s back as \n).
  //
  // They are DELIBERATELY not cleared on mode change: switching the slider should
  // reuse anything already computed. resultCache is keyed by mode, so crap and
  // decrap results never collide.
  const resultCache = new Map(); // `${mode}\u0000${fp(src)}` -> transformed text
  const outputs = new Map(); // fp(text WE produced) -> the source it came from
  const countedOriginals = new Set(); // `${mode}\u0000${fp(src)}` already tallied into stats

  // Whitespace-normalized fingerprint: the single source of identity for a block.
  const fp = (t) => (t || "").replace(/\s+/g, " ").trim();
  const rkey = (src) => mode + "\u0000" + fp(src);

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
      // Never ascend into a container that already holds a block we've processed.
      // Once a child is transformed+MARKed it stops counting as a "qualifying
      // child", which would otherwise make the parent look like a fresh minimal
      // block — we'd then re-transform (wrapping our own output) AND snapshot the
      // already-transformed HTML as the "original", so restoring to Normal would
      // leave the transformed text on the page.
      if (el.querySelector && el.querySelector("[" + MARK + "]")) continue;
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

  // Put an element back to its pre-transform state. We usually have the exact
  // original markup (`html`); for the rare case where we only recovered the
  // source text (a re-mount that arrived already showing our output), we render
  // that text instead so "Normal" is never left with transformed content.
  function restoreEl(el, snap) {
    if (!snap) return;
    if (snap.html != null) el.innerHTML = snap.html;
    else if (snap.text != null) setBlockText(el, snap.text);
  }

  // Inject the loader's pulse animation once. Opacity-only so it can't clash with
  // the host page's colors/layout.
  function ensureLoadingStyle() {
    if (document.getElementById("ctc-style")) return;
    const st = document.createElement("style");
    st.id = "ctc-style";
    st.textContent =
      "." + LOADING_CLASS + "{font-style:italic;animation:ctc-pulse 1.1s ease-in-out infinite}" +
      "@keyframes ctc-pulse{0%,100%{opacity:.35}50%{opacity:.8}}";
    (document.head || document.documentElement).appendChild(st);
  }

  // Swap the given blocks to a "cooking" placeholder before their model call.
  // We snapshot the true original into `originals` FIRST (so restore/unchanged
  // paths recover it) and MARK them so a rescan won't re-collect them mid-flight.
  function beginLoading(blocks) {
    if (!blocks.length) return;
    ensureLoadingStyle();
    const label = LOADING_LABEL[mode] || "🍳 cooking";
    withWriteGuard(() => {
      for (const b of blocks) {
        if (!originals.has(b.el)) originals.set(b.el, { html: b.el.innerHTML });
        b.el.setAttribute(MARK, "1");
        b.el.classList.add(LOADING_CLASS);
        b.el.textContent = label + "…";
      }
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
    // A batch may resolve after the user flipped the mode/off; by then restoreAll
    // has already cleaned these elements, so writing now would resurrect stale
    // text (and re-show loaders). Bail — the cleanup already happened.
    if (!active) return;

    let wordsCut = 0; // words removed (decrapify shrinks)
    let wordsAdded = 0; // words added (crapify grows)
    let swapped = 0;

    withWriteGuard(() => {
      for (const { b, next: rawNext, cached } of pairs) {
        // If this block is showing the "cooking" loader, its current innerHTML is
        // the placeholder — the true original was stashed in `originals` by
        // beginLoading. `restoreOriginal` puts that real markup back.
        const loading = b.el.classList.contains(LOADING_CLASS);
        const restoreOriginal = () => {
          restoreEl(b.el, originals.get(b.el));
          b.el.classList.remove(LOADING_CLASS);
        };

        if (rawNext == null) {
          // failed/omitted — undo the loader (if any) and leave the real original,
          // unmarked so a later rescan can retry it.
          if (loading) {
            restoreOriginal();
            originals.delete(b.el);
            b.el.removeAttribute(MARK);
          }
          log("· no result — left original:", preview(b.text));
          continue;
        }
        const next = normalizeText(rawNext);
        if (next.trim() === b.text.trim()) {
          // model left it as-is (already honest / not really prose). Cache the
          // no-op so re-encountering this text never pays for another call, then
          // recover the real original from behind any loader and mark it done.
          resultCache.set(rkey(b.text), b.text);
          if (loading) {
            restoreOriginal();
            originals.delete(b.el);
          }
          if (!cached) log("· unchanged by model:", preview(b.text));
          b.el.setAttribute(MARK, "1");
          continue;
        }

        // Remember the source<->output mapping so scrolling and slider changes
        // reuse it, and so a block re-mounted still showing our output can be
        // traced back to its source instead of being transformed again.
        resultCache.set(rkey(b.text), next);
        outputs.set(fp(next), b.text);

        // If the element already displays exactly this output (e.g. a re-mounted
        // copy that kept our text), don't rewrite — but still record how to get
        // back to the source (as text), so switching to Normal reverts it.
        if (!loading && fp(fullText(b.el)) === fp(next)) {
          if (!originals.has(b.el)) originals.set(b.el, { text: b.text });
          b.el.setAttribute(MARK, "1");
          continue;
        }

        // Only snapshot here when we didn't already (i.e. no loader was shown);
        // otherwise `originals` already holds the true original, not the loader.
        if (!originals.has(b.el)) originals.set(b.el, { html: b.el.innerHTML });
        b.el.classList.remove(LOADING_CLASS);
        b.el.setAttribute(MARK, "1");
        setBlockText(b.el, next);
        swapped++;

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
      for (const [el, snap] of originals) {
        restoreEl(el, snap); // reverts swapped text AND any in-flight loader
        el.classList.remove(LOADING_CLASS);
        el.removeAttribute(MARK);
      }
      originals.clear();
      // also clean up blocks that were "already honest" or still cooking
      document.querySelectorAll("[" + MARK + "]").forEach((el) => {
        el.classList.remove(LOADING_CLASS);
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

    // Partition the collected blocks into ones we can resolve locally (already
    // handled this session — the common case when scrolling a virtualized feed
    // re-mounts old posts) vs genuinely new blocks that must go to the model.
    const localPairs = []; // resolved from cache — no network
    const blocks = []; // need a model call
    for (const el of els) {
      const shown = fullText(el);
      // If this node currently shows text WE produced (a re-mount that kept our
      // output), trace it back to its source so we re-derive from the original
      // and never feed our own output into the model.
      const src = outputs.get(fp(shown)) || shown;
      const b = { el, text: src };

      const hit = resultCache.get(rkey(src));
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

    // Show the "cooking" placeholder on every model-bound block up front, so the
    // whole batch signals activity immediately rather than one batch at a time.
    beginLoading(blocks);

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
        if (!resp) return applyResults(batch, []); // clear loaders, allow retry
        if (resp.error === "NO_API_KEY") {
          log("NO API KEY set — open Settings and add your OpenAI key");
          active = false; // nothing we can do without a key
          restoreAll(); // take down every loader we put up
          return;
        }
        if (resp.error) log("batch error from background:", resp.error);
        // Pass whatever came back (possibly empty): matched ids swap in, the rest
        // revert from the loader to their original so they aren't stuck cooking.
        applyResults(batch, resp.results || []);
      } catch (e) {
        log("sendMessage failed for a batch:", e);
        applyResults(batch, []); // revert loaders; a later rescan can retry
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

    // Note: the result caches are intentionally kept across mode changes. They're
    // keyed by mode + fingerprint, so flipping the slider reuses anything already
    // computed instead of spending calls to redo it.

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
