# Cut the Crap / Pile on the Crap

A browser extension with a **three-way mode selector** that rewrites the prose on any page in either direction:

```
  crapify      NORMAL      decrapify
   ← ── corporate bloat | brutal honesty ── →
```

- **Cut the Crap** (decrapify) — compress bloated, jargon-heavy text (LinkedIn posts, corporate emails, marketing waffle) toward the one honest sentence it was actually trying to say.
  > 200-word humblebrag about "embarking on a new professional chapter" → **"I got a new job."**
- **Pile on the Crap** (crapify) — the reverse: inflate a plain statement into self-congratulatory corporate waffle.
  > **"I got a new job."** → a 200-word saga about "embarking on a new professional chapter."
- **Normal** — the extension does nothing.

Three stops total — **Crapify · Normal · Decrapify** — with Normal in the centre.

Firefox-first (Manifest V3), portable to Chrome with minimal changes.

## Load it into Firefox (temporary add-on)

1. Go to `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
2. Select `manifest.json` in this folder.
3. Open the extension's **Settings** (via the popup's "Settings / API key" link), pick a **provider** (OpenAI, Anthropic, Google, or MiniMax), and paste that provider's API key. Each provider keeps its own key + model, so you can switch freely without re-entering anything.
4. Visit a page, click the toolbar icon, then select **Crapify**, **Normal**, or **Decrapify** for that site.

## Providers

The extension is provider-agnostic — it speaks one internal JSON batch contract and each backend is a thin adapter in `providers.js`. Supported out of the box:

| Provider | Setting | Default model | Notes |
|---|---|---|---|
| **OpenAI (GPT)** | `openai` | `gpt-4o-mini` | Native JSON mode. |
| **Anthropic (Claude)** | `anthropic` | `claude-3-5-haiku-latest` | Uses `anthropic-dangerous-direct-browser-access` for BYOK browser calls; no JSON mode, so output is parsed tolerantly. |
| **Google (Gemini)** | `google` | `gemini-2.5-flash` | Native JSON mode via `responseMimeType`. |
| **MiniMax** | `minimax` | `MiniMax-M2.5` | OpenAI-compatible endpoint; output parsed tolerantly. |

Adding another provider = one entry in `providers.js` (`buildRequest` + `parseResponse`) plus its API host in `manifest.json` `host_permissions`. Nothing else in the extension needs to change.

Note: temporary add-ons are removed when Firefox restarts — re-load before each session.

## How it works

- Every site starts on **Normal**. The chosen mode is remembered per domain (like Dark Reader). Stored as a string: `off` / `crap` / `decrap` (legacy values — the old boolean `true` and the old 5-stop keys — are folded onto these).
- On any non-Normal mode, the content script finds prose blocks (≥150 chars), batches them to the background worker → the selected provider (with that mode's voice) → swaps the text in place as each batch resolves. No page refresh.
- While a block is in flight it shows a pulsing on-brand placeholder (`🔪 cutting the crap…` / `🍳 piling on the crap…`) so the wait reads as activity; the real original is stashed first and restored if the model returns nothing, errors, or leaves the text unchanged.
- Switching mode (including back to Normal) restores the original text first, so e.g. going from decrapify to crapify always starts from the real source text, not already-rewritten DOM.
- The popup shows lifetime totals: **words cut** (decrapify), **words piled on** (crapify), and pages processed.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 config (Firefox event page, `<all_urls>` content script, popup, options) |
| `content.js` | Finds prose blocks, swaps/restores text, reacts to the per-site mode |
| `prompt.js` | **The voices** — two mode prompts (cut/pile) + few-shot examples. Iterate on the humor here. |
| `providers.js` | **The backends** — one adapter per LLM (OpenAI/Claude/Gemini/MiniMax): endpoint, headers, body shape, response parsing. Also resolves the per-provider settings schema. |
| `background.js` | Provider-agnostic LLM calls (mode + provider aware), response cache, lifetime stats |
| `popup.html` / `popup.js` | Per-site mode selector + lifetime stats |
| `options.html` / `options.js` | Provider picker + per-provider API key & model |
| `lib/browser-polyfill.js` | `browser.*` promise API (Firefox native; needed for Chrome) |
| `icons/` | Placeholder icons (replace later) |

## Tuning the voice

`prompt.js` is the product surface. It defines a `MODES` map — each mode has a `STYLE` block, a set of few-shot pairs, and a `temperature`, assembled into one system prompt via `buildPrompt()`. Few-shot examples steer the tone far more reliably than long instructions.

The before→after pairs are written **once** in the decrapify direction (bloated → honest); the crapify mode reuses the same pairs with the arrow flipped (`flip()`), so both directions share a single source of humour. Add sharp pairs to `DECRAP_PAIRS` to steer both directions at once.

The examples are embedded inside each system prompt; the actual request uses a JSON batch contract (`{"blocks":[...]}` in, `{"results":[...]}` out) that is **identical across modes** (the `CONTRACT` constant), so don't restructure the message format. The content script passes the active `mode` on each `compress` message and the background worker folds it into the cache key.

## Design notes / guardrails

- **Detects leaf prose blocks**, not raw text nodes — skips `pre`/`code`, `nav`, `[contenteditable]`, inputs, and hidden elements, so it won't rewrite what you're typing or mangle code.
- **Reversible**: originals are kept in memory and restored on toggle-off.
- **Dynamic pages**: a `MutationObserver` catches lazily loaded / infinite-scroll content; it is guarded so the extension's own writes don't retrigger it. On LinkedIn, collapsed posts are expanded before their text is collected.
- **Viewport-first queue**: on activation (and as you scroll) blocks are drained **nearest-the-viewport first** — what you're looking at is transformed before anything off-screen, and scrolling re-prioritizes the remaining queue toward the newly-visible section. The "cooking" loader only appears on a block once it's actually dispatched, so queued off-screen sections keep their original text until their turn. A debounced scroll listener (plus the `MutationObserver`) enqueues blocks that come near later.
- **Batched + capped**: ~6 blocks/request, ≤3 concurrent, nearest ≤100 blocks queued per scan (≤500 candidates examined).
- **Cached (two layers, both keyed by a whitespace-normalized fingerprint)**: the content script keeps a per-session `mode → source → output` map plus a reverse `output → source` map, so scrolling a virtualized feed (Reddit/LinkedIn) that re-mounts a post re-applies the stored result with no network call, and a re-mounted node still showing our own text is traced back to its source rather than transformed again ("crap on crap"). These survive slider changes (keyed by mode), so flipping between crapify/decrapify/normal never recomputes. Underneath, the background worker also caches every transformation in `storage.local`, so the same text stays free across reloads.
- **Error isolation**: one batch failing leaves those blocks untouched; the rest of the page still processes. No API key → the toggle sends you to Settings instead of failing silently.
- **Privacy**: page text is sent to your selected provider only for sites you switch on (default off).

## Chrome port (later)

Replace the manifest `background` block with a service worker:

```json
"background": { "service_worker": "background.js" }
```

Since `prompt.js` and `providers.js` are plain scripts that attach `CTC_VOICE` / `CTC_PROVIDERS` to the global scope, load them via `importScripts("lib/browser-polyfill.js", "prompt.js", "providers.js")` at the top of `background.js` for the Chrome build.
