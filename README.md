# Cut the Crap

A browser extension that compresses bloated, jargon-heavy text (LinkedIn posts, corporate emails, marketing waffle) into the one honest sentence it was actually trying to say.

> 200-word humblebrag about "embarking on a new professional chapter" → **"I got a new job."**

Firefox-first (Manifest V3), portable to Chrome with minimal changes.

## Load it into Firefox (temporary add-on)

1. Go to `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
2. Select `manifest.json` in this folder.
3. Open the extension's **Settings** (via the popup's "Settings / API key" link) and paste your OpenAI API key. Model defaults to `gpt-4o-mini`.
4. Visit a bloated page, click the toolbar icon, and flip **Decrappify this site** on.

Note: temporary add-ons are removed when Firefox restarts — re-load before each session.

## How it works

- Every site starts **OFF**. State is remembered per domain (like Dark Reader).
- When ON, the content script finds prose blocks (≥150 chars), batches them to the background worker → OpenAI → swaps the text in place as each batch resolves. No page refresh.
- When OFF, original text is restored instantly and no more API calls are made.
- The popup shows lifetime totals only: words cut, pages processed, overall % shorter.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 config (Firefox event page, `<all_urls>` content script, popup, options) |
| `content.js` | Finds prose blocks, swaps/restores text, reacts to the per-site toggle |
| `prompt.js` | **The decrappification voice** — system prompt + few-shot examples. Iterate on the humor here. |
| `background.js` | OpenAI calls, response cache, lifetime stats |
| `popup.html` / `popup.js` | Per-site toggle + lifetime stats |
| `options.html` / `options.js` | OpenAI API key + model |
| `lib/browser-polyfill.js` | `browser.*` promise API (Firefox native; needed for Chrome) |
| `icons/` | Placeholder icons (replace later) |

## Tuning the voice

`prompt.js` is the product surface. Add sharp before/after pairs to `EXAMPLES` — few-shot examples steer the tone far more reliably than long instructions. The examples are embedded inside the system prompt; the actual request uses a JSON batch contract (`{"blocks":[...]}` in, `{"results":[...]}` out), so don't restructure the message format.

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
