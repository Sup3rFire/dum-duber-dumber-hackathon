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
  // Minimum block length to bother transforming, PER MODE. Crapify inflates, so
  // it's worth firing on short sentences; decrapify compresses, so there's little
  // point on text that's already short. `minChars()` reads the active mode.
  const MIN_CHARS = { crap: 40, decrap: 100 };
  const DEFAULT_MIN_CHARS = 100;
  const minChars = () => MIN_CHARS[mode] ?? DEFAULT_MIN_CHARS;

  // Skip HEADLINE / display text (font markedly larger than body text). It's a
  // title, not prose, and rewriting it — especially crapify's ~8x inflation —
  // overflows the heading's box and paints a wall of giant text over the page.
  // Matters most now that the crapify length floor is low enough to catch short
  // headings. Relative to the root font so it holds on any site's base size.
  const MAX_FONT_MULT = 1.8;
  const BATCH_SIZE = 6; // blocks per LLM request
  const CONCURRENCY = 3; // max in-flight requests
  const MAX_BLOCKS = 100; // nearest-to-viewport blocks queued per scan
  const COLLECT_CAP = 500; // absolute ceiling on candidates examined per scan
  const MARK = "data-ctc"; // marks a processed element
  const RESCAN_DEBOUNCE = 400; // ms to coalesce MutationObserver bursts
  const SCROLL_DEBOUNCE = 200; // ms to coalesce scroll-driven rescans

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

  // Never touch these (or anything inside them). Besides <nav>, cover the ARIA
  // navigation/menu landmarks sites use when they build nav out of div/ul instead
  // of a semantic <nav> — otherwise a link bar can clear the (now low) crapify
  // length floor and get rewritten.
  const EXCLUDE_CLOSEST =
    "pre,code,kbd,samp,nav,textarea,[contenteditable],[contenteditable='true']," +
    '[role="navigation"],[role="menu"],[role="menubar"],[role="tablist"],[role="banner"]';

  // A block that is mostly hyperlink/button text is navigation (nav bar, menu,
  // breadcrumb, footer link list, tag cloud), not prose. Real prose has at most a
  // couple of inline links, so a high link-text ratio is a reliable "skip me".
  const LINK_TEXT_RATIO = 0.6;
  function isLinkHeavy(el) {
    const total = (el.textContent || "").replace(/\s+/g, "").length;
    if (!total) return true;
    let linked = 0;
    for (const a of el.querySelectorAll("a,button")) {
      linked += (a.textContent || "").replace(/\s+/g, "").length;
    }
    return linked / total > LINK_TEXT_RATIO;
  }
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
  let observer = null;
  let rescanTimer = null;
  let scrollTimer = null;

  // ---------- viewport-prioritized work queue ----------
  // New blocks don't all fire at once. They wait here and are drained
  // NEAREST-THE-VIEWPORT first, so activating transforms what you're looking at
  // before anything off-screen. pump() re-sorts on every dispatch using the
  // CURRENT scroll position, so scrolling bumps the newly-visible section to the
  // front of the queue.
  const pending = []; // [{ el, text }] blocks awaiting a model call
  let pendingEls = new WeakSet(); // dedup: elements already queued
  let inFlight = 0; // in-flight batch requests (<= CONCURRENCY)

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
  const countedOriginals = new Set(); // `${mode}\u0000${fp(src)}` already logged (verbose swap log gate)

  // Whitespace-normalized fingerprint: the single source of identity for a block.
  const fp = (t) => (t || "").replace(/\s+/g, " ").trim();
  const rkey = (src) => mode + "\u0000" + fp(src);

  // ---------- helpers ----------
  // Canonical newline form: \n only, at most one blank line between paragraphs.
  // Used both when rendering output and when caching it, so a re-read of our own
  // DOM (innerText turns <br> back into \n) matches what we stored.
  const normalizeText = (t) =>
    t.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n");

  // Short one-line preview of a block, for logging.
  function preview(text, n = 80) {
    const t = (text || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  }

  function isVisible(el) {
    return el.getClientRects().length > 0;
  }

  // Base (root) font size, cached — the yardstick for "is this headline-sized?".
  let baseFontPx = 0;
  function rootFontPx() {
    if (!baseFontPx) {
      baseFontPx =
        parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    }
    return baseFontPx;
  }

  // True for headline / hero / display text we should NOT rewrite (see MAX_FONT_MULT).
  function isOversizedText(el) {
    const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
    return fs > rootFontPx() * MAX_FONT_MULT;
  }

  // How far a block is from the viewport, in px: 0 while it intersects the
  // viewport, otherwise the gap to the nearest edge (above or below). Detached /
  // hidden elements sort to the very back. This is the queue's priority key.
  function viewportDistance(el) {
    if (!el.isConnected) return Infinity;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return Infinity;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (r.bottom < 0) return -r.bottom; // fully above the viewport
    if (r.top > vh) return r.top - vh; // fully below the viewport
    return 0; // intersecting the viewport
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

  const LINKEDIN_EXPAND_SEL = '[data-testid="expandable-text-button"]';
  const isLinkedIn = /(^|\.)linkedin\.com$/i.test(HOST);
  // A feed re-render can replace a button with a fresh DOM node, so remember
  // clicks by element rather than globally. This expands newly loaded posts
  // while ensuring a later scan never turns an existing post back into a clamp.
  const clickedLinkedInExpandButtons = new WeakSet();

  function isCollapsedLinkedInExpandButton(button) {
    if (button.getAttribute("aria-expanded") === "true") return false;
    const label = [button.getAttribute("aria-label"), button.textContent]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return !/\b(?:less|collapse)\b/.test(label);
  }

  // A button is worth expanding once it's within one viewport of the reader.
  // Clicking only nearby posts (rather than every button in the feed) is what
  // stops the page from being dragged to the bottom; the rest expand naturally
  // as the MutationObserver rescans on scroll.
  function isNearLinkedInExpandButton(button) {
    const r = button.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false; // detached / hidden
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return r.bottom >= -vh && r.top <= vh * 2;
  }

  // LinkedIn keeps the rest of a post behind this control. Open collapsed posts
  // near the viewport before collecting prose so the model receives the full
  // text. A programmatic .click() focuses the button and the browser scrolls
  // that focused element into view, so we (a) only click buttons already near
  // the reader and (b) pin the scroll offset across the pass — otherwise the
  // feed jumps to whichever post was expanded last.
  // Returns true when React needs a frame to render at least one expanded post.
  function expandLinkedInPosts() {
    if (!isLinkedIn) return false;

    const scroller = document.scrollingElement || document.documentElement;
    const sx = scroller.scrollLeft;
    const sy = scroller.scrollTop;
    let expanded = false;
    for (const button of document.querySelectorAll(LINKEDIN_EXPAND_SEL)) {
      if (clickedLinkedInExpandButtons.has(button)) continue;
      // Don't mark far-off buttons as seen — they should still expand once the
      // reader scrolls them into range on a later scan.
      if (!isNearLinkedInExpandButton(button)) continue;
      clickedLinkedInExpandButtons.add(button);
      if (!isCollapsedLinkedInExpandButton(button)) continue;
      button.click();
      expanded = true;
    }
    if (expanded && (scroller.scrollLeft !== sx || scroller.scrollTop !== sy)) {
      scroller.scrollLeft = sx;
      scroller.scrollTop = sy;
    }
    return expanded;
  }

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
    const min = minChars();
    for (const c of el.children) {
      if (!isExcluded(c) && tlen(c) >= min) return true;
    }
    return false;
  }

  // Collect the smallest qualifying blocks, descending into open shadow roots
  // (modern Reddit, YouTube, etc. render content inside web components).
  function collectFrom(root, out) {
    const nodes = root.querySelectorAll(CANDIDATE_SEL);
    for (const el of nodes) {
      if (out.length >= COLLECT_CAP) return;
      if (isExcluded(el)) continue;
      if (!inScope(el)) continue; // scoped site: skip anything outside content regions
      // Never ascend into a container that already holds a block we've processed.
      // Once a child is transformed+MARKed it stops counting as a "qualifying
      // child", which would otherwise make the parent look like a fresh minimal
      // block — we'd then re-transform (wrapping our own output) AND snapshot the
      // already-transformed HTML as the "original", so restoring to Normal would
      // leave the transformed text on the page.
      if (el.querySelector && el.querySelector("[" + MARK + "]")) continue;
      if (tlen(el) < minChars()) continue;
      if (hasQualifyingChild(el)) continue; // not the minimal block
      if (!isVisible(el)) continue;
      if (isOversizedText(el)) continue; // headline/hero text — rewriting wrecks layout
      if (isLinkHeavy(el)) continue; // nav bar / menu / link list — not prose
      if (fullText(el).length < minChars()) continue; // accurate check (counts hidden "see more" text)
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

  // ---------- viewport-prioritized queue: enqueue / pump / process ----------
  // Add new blocks to the back of the queue (deduped). Priority is decided at
  // dispatch time in pump(), not here, so a block enqueued while off-screen still
  // jumps the queue the moment you scroll it into view.
  function enqueue(blocks) {
    for (const b of blocks) {
      if (pendingEls.has(b.el)) continue;
      pendingEls.add(b.el);
      pending.push(b);
    }
  }

  function clearQueue() {
    pending.length = 0;
    pendingEls = new WeakSet();
  }

  // Drain the queue up to CONCURRENCY in-flight batches. Each batch is the set of
  // currently-nearest blocks, so the viewport is always served first and the
  // ordering re-evaluates against the live scroll position on every dispatch.
  function pump() {
    if (!active) return;
    while (inFlight < CONCURRENCY && pending.length) {
      pending.sort((a, b) => viewportDistance(a.el) - viewportDistance(b.el));
      const batch = [];
      while (batch.length < BATCH_SIZE && pending.length) {
        const item = pending.shift();
        pendingEls.delete(item.el);
        if (!item.el.isConnected) continue; // unmounted while queued — drop it
        batch.push(item);
      }
      if (!batch.length) continue; // whole slice was dead; keep draining
      inFlight++;
      processBatch(batch).finally(() => {
        inFlight--;
        pump();
      });
    }
  }

  // Transform one batch: show its loaders, call the model, swap results in. The
  // loader is applied HERE (not when queued) so off-screen blocks keep their
  // original text until it's actually their turn.
  async function processBatch(batch) {
    if (!active) return;
    const batchMode = mode; // guard against a flip landing a stale-mode response
    beginLoading(batch);
    try {
      const resp = await browser.runtime.sendMessage({
        type: "compress",
        mode: batchMode,
        url: location.href, // lets the background count paid pages, deduped per (url, mode)
        blocks: batch.map((b, i) => ({ id: "b" + i, text: b.text })),
      });
      // If the mode changed while this was in flight, the flip's restoreAll has
      // already reverted these elements — applying now would paint the wrong
      // mode's text and poison the cache. Drop it; the new mode re-queues them.
      if (!active || mode !== batchMode) return;
      log("compress response:", resp);
      if (!resp) return applyResults(batch, []); // clear loaders, allow retry
      if (resp.error === "NO_API_KEY") {
        log("NO API KEY set — open Settings and add your provider API key");
        active = false; // nothing we can do without a key
        clearQueue();
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

  // Pick a real content element near the top of the viewport to hold steady
  // across a DOM write. We hit-test a little way down the viewport (below any
  // sticky nav) and climb out of fixed/sticky chrome so we anchor to page
  // content, not the header. Returns the element and its current screen offset.
  function pickScrollAnchor() {
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const x = Math.min(vw * 0.5, vw - 1);
    for (const frac of [0.3, 0.5, 0.15, 0.7]) {
      let el = document.elementFromPoint(x, Math.round(vh * frac));
      while (el && el !== document.body && el !== document.documentElement) {
        const pos = getComputedStyle(el).position;
        if (pos !== "fixed" && pos !== "sticky") break;
        el = el.parentElement;
      }
      if (el && el !== document.body && el !== document.documentElement) {
        return { el, top: el.getBoundingClientRect().top };
      }
    }
    return null;
  }

  function withWriteGuard(fn) {
    writing = true;
    if (observer) observer.disconnect();
    // Rewrites change block heights (crapify grows, decrapify shrinks); when
    // that happens above the viewport the page appears to jump. Anchor a visible
    // element and, after the write, correct scrollTop by however far it moved so
    // the reader's spot stays put.
    const anchor = pickScrollAnchor();
    try {
      fn();
    } finally {
      if (anchor && anchor.el.isConnected) {
        const delta = anchor.el.getBoundingClientRect().top - anchor.top;
        if (delta) {
          const scroller = document.scrollingElement || document.documentElement;
          scroller.scrollTop += delta;
        }
      }
      if (observer && active) observer.observe(document.body, OBS_OPTS);
      writing = false;
    }
  }

  // Apply a list of { b, next, cached } swaps in a single write pass. `cached`
  // marks a re-application from the content cache (no model call happened), so we
  // can log it quietly. NOTE: word stats are tallied by the BACKGROUND, on the
  // paid cache miss — not here — so toggling modes / reloading (which serve from
  // cache) never re-inflates the totals. Same logic as the page counter.
  function applySwaps(pairs) {
    // A batch may resolve after the user flipped the mode/off; by then restoreAll
    // has already cleaned these elements, so writing now would resurrect stale
    // text (and re-show loaders). Bail — the cleanup already happened.
    if (!active) return;

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
          countedOriginals.add(key); // gates verbose logging only, not stats
          // Full before -> after, so you can see exactly what the model returned.
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
  }

  // Adapter for a model response batch: map ids back to blocks, then apply.
  function applyResults(batch, results) {
    const byId = new Map(results.map((r) => [String(r.id), r.text]));
    applySwaps(batch.map((b, i) => ({ b, next: byId.get("b" + i) })));
  }

  function restoreAll() {
    // Drop anything still queued — its element was never touched, so there's
    // nothing to revert; we just stop it from being processed after teardown.
    clearQueue();
    withWriteGuard(() => {
      // 1) Revert everything we explicitly tracked — exact original markup.
      for (const [el, snap] of originals) {
        restoreEl(el, snap); // reverts swapped text AND any in-flight loader
        el.classList.remove(LOADING_CLASS);
        el.removeAttribute(MARK);
      }
      originals.clear();

      // 2) Safety net for virtualized feeds: a post can be re-mounted as a NEW
      // element that still shows our output but was never tracked (its element
      // identity changed and the MARK was lost). Sweep the page and, for any
      // block whose visible text is one WE produced, put its source text back.
      // Keyed by the same whitespace fingerprint used everywhere else, so
      // multi-line output still matches when read back via innerText.
      if (outputs.size) {
        const sel = SCOPE_SEL || CANDIDATE_SEL;
        document.querySelectorAll(sel).forEach((el) => {
          if (isExcluded(el) && !el.hasAttribute(MARK)) return; // skip pre/code/nav etc.
          const src = outputs.get(fp(fullText(el)));
          if (src != null) {
            setBlockText(el, src);
            el.classList.remove(LOADING_CLASS);
            el.removeAttribute(MARK);
          }
        });
      }

      // 3) Clean up any leftover markers ("already honest" / still cooking).
      document.querySelectorAll("[" + MARK + "]").forEach((el) => {
        el.classList.remove(LOADING_CLASS);
        el.removeAttribute(MARK);
      });
    });
  }

  // ---------- main scan ----------
  async function scan() {
    if (!active) return;
    if (expandLinkedInPosts()) {
      // Let LinkedIn commit the expanded post body before it enters collection.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (!active) return;
    }
    const els = collectBlocks();
    if (SCOPE_SEL) {
      log("scoped regions on page:", document.querySelectorAll(SCOPE_SEL).length);
    }
    log("scan found", els.length, "block(s)");
    if (!els.length) return;

    // NOTE: page counting is NOT done here. The background worker owns it, because
    // only it knows whether a transformation was actually PAID for (an uncached
    // API call) vs served from its persistent cache. It increments "pages" once
    // per (url, mode) when a real call happens — so a fresh uncached load counts,
    // flipping to the other mode counts if that mode wasn't cached, and reloads /
    // scrolls / flipping back to an already-computed mode cost nothing and don't
    // count. See handleTransform() in background.js.

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

    // Queue the blocks NEAREST the viewport first. pump() re-sorts by live scroll
    // position on every dispatch, so this ordering is just the initial hint; what
    // ultimately goes first is whatever is on screen when a slot frees up. We cap
    // per scan at the nearest MAX_BLOCKS; the rest are picked up by later scans
    // (scroll / mutation) once they come near.
    blocks.sort((a, b) => viewportDistance(a.el) - viewportDistance(b.el));
    enqueue(blocks.slice(0, MAX_BLOCKS));
    pump();
  }

  function scheduleRescan() {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      scan();
    }, RESCAN_DEBOUNCE);
  }

  // Scrolling re-prioritizes the queue toward what's now on screen and lets us
  // pick up blocks that were too far away (or beyond MAX_BLOCKS) on earlier
  // scans. Debounced, and cheap while idle since it no-ops when nothing changed.
  // capture:true so it also catches scrolling inside nested scroll containers,
  // whose scroll events don't bubble to window.
  function onScroll() {
    if (!active || scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      if (!active) return;
      pump(); // reprioritize the existing queue against the new viewport
      scan(); // enqueue any newly-near blocks
    }, SCROLL_DEBOUNCE);
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
    if (scrollTimer) {
      clearTimeout(scrollTimer);
      scrollTimer = null;
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

  // One passive, self-gating scroll listener drives viewport re-prioritization.
  document.addEventListener("scroll", onScroll, { passive: true, capture: true });

  init();
})();
