# Cut the Crap / Pile on the Crap

A browser extension with a **spectrum slider** that rewrites the prose on any page in either direction:

```
 EXTREME     MILD       NORMAL        MILD      EXTREME
 crapify    crapify   (untouched)   decrapify  decrapify
   ← ── more corporate bloat ── | ── more brutal honesty ── →
```

- **Cut the Crap** (decrapify) — compress bloated, jargon-heavy text (LinkedIn posts, corporate emails, marketing waffle) toward the one honest sentence it was actually trying to say.
  > 200-word humblebrag about "embarking on a new professional chapter" → **"I got a new job."**
- **Pile on the Crap** (crapify) — the reverse: inflate a plain statement into self-congratulatory corporate waffle.
  > **"I got a new job."** → a 200-word saga about "embarking on a new professional chapter."
- **Normal** — the extension does nothing.

Each direction has a **Mild** and an **Extreme** setting. Five stops total, with Normal in the centre.

Firefox-first (Manifest V3), portable to Chrome with minimal changes.

## Load it into Firefox (temporary add-on)

1. Go to `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
2. Select `manifest.json` in this folder.
3. Open the extension's **Settings** (via the popup's "Settings / API key" link) and paste your OpenAI API key. Model defaults to `gpt-4o-mini`.
4. Visit a page, click the toolbar icon, and drag the **spectrum slider** off Normal — left to pile on the crap, right to cut it.

Note: temporary add-ons are removed when Firefox restarts — re-load before each session.

## How it works

- Every site starts on **Normal**. The chosen mode is remembered per domain (like Dark Reader). Stored as a string: `off` / `decrap-mild` / `decrap-extreme` / `crap-mild` / `crap-extreme` (a legacy boolean `true` is read as `decrap-extreme`).
- On any non-Normal mode, the content script finds prose blocks (≥150 chars), batches them to the background worker → OpenAI (with that mode's voice) → swaps the text in place as each batch resolves. No page refresh.
- Switching mode (including back to Normal) restores the original text first, so e.g. going from decrapify to crapify always starts from the real source text, not already-rewritten DOM.
- The popup shows lifetime totals: **words cut** (decrapify), **words piled on** (crapify), and pages processed.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 config (Firefox event page, `<all_urls>` content script, popup, options) |
| `content.js` | Finds prose blocks, swaps/restores text, reacts to the per-site mode |
| `prompt.js` | **The voices** — four mode prompts (mild/extreme × cut/pile) + few-shot examples. Iterate on the humor here. |
| `background.js` | OpenAI calls (mode-aware), response cache, lifetime stats |
| `popup.html` / `popup.js` | Per-site spectrum slider + lifetime stats |
| `options.html` / `options.js` | OpenAI API key + model |
| `lib/browser-polyfill.js` | `browser.*` promise API (Firefox native; needed for Chrome) |
| `icons/` | Placeholder icons (replace later) |

## Tuning the voice

`prompt.js` is the product surface. It defines a `MODES` map — each mode has a `STYLE` block, a set of few-shot pairs, and a `temperature`, assembled into one system prompt via `buildPrompt()`. Few-shot examples steer the tone far more reliably than long instructions.

The before→after pairs are written **once** in the decrapify direction (bloated → honest); the crapify modes reuse the same pairs with the arrow flipped (`flip()`), so both directions share a single source of humour. Add sharp pairs to `DECRAP_EXTREME_PAIRS` / `DECRAP_MILD_PAIRS` to steer everything at once.

The examples are embedded inside each system prompt; the actual request uses a JSON batch contract (`{"blocks":[...]}` in, `{"results":[...]}` out) that is **identical across modes** (the `CONTRACT` constant), so don't restructure the message format. The content script passes the active `mode` on each `compress` message and the background worker folds it into the cache key.

## Design notes / guardrails

- **Detects leaf prose blocks**, not raw text nodes — skips `pre`/`code`, `nav`, `[contenteditable]`, inputs, and hidden elements, so it won't rewrite what you're typing or mangle code.
- **Reversible**: originals are kept in memory and restored on toggle-off.
- **Dynamic pages**: a `MutationObserver` catches lazily loaded / infinite-scroll content; it is guarded so the extension's own writes don't retrigger it.
- **Batched + capped**: ~6 blocks/request, ≤3 concurrent, ≤100 blocks/page.
- **Cached**: identical text (per model) is cached in `storage.local`, so re-running on the same page is instant and free.
- **Error isolation**: one batch failing leaves those blocks untouched; the rest of the page still processes. No API key → the toggle sends you to Settings instead of failing silently.
- **Privacy**: page text is sent to OpenAI only for sites you switch on (default off).

## Chrome port (later)

Replace the manifest `background` block with a service worker:

```json
"background": { "service_worker": "background.js" }
```

Since `prompt.js` is a plain script that attaches `CTC_VOICE` to the global scope, load it via `importScripts("lib/browser-polyfill.js", "prompt.js")` at the top of `background.js` for the Chrome build.
