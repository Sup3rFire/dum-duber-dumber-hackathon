// Background event page: LLM calls, response cache, lifetime stats.
// Loaded after lib/browser-polyfill.js, prompt.js and providers.js (see manifest).
// Uses CTC_VOICE.configFor(mode) from prompt.js to pick the right voice, and
// CTC_PROVIDERS.configFor(provider) to pick the right backend (OpenAI / Claude /
// Gemini / MiniMax). The message shape sent to the model is identical for every
// provider — only the HTTP envelope differs (see providers.js).

const CACHE_PREFIX = "c:"; // storage key prefix for cached transformations

const DEBUG = true; // set false to silence
const log = (...a) => DEBUG && console.log("%c[CTC-bg]", "color:#911eb4", ...a);
log("background worker loaded");

// ---- settings ----
// Reads the multi-provider schema and folds in the legacy OpenAI-only keys.
// Returns { provider, apiKey, model } for the ACTIVE provider.
async function getSettings() {
  const store = await browser.storage.local.get([
    "provider",
    "apiKeys",
    "models",
    "apiKey",
    "model",
  ]);
  return CTC_PROVIDERS.resolveSettings(store);
}

// ---- cache (in-memory + storage.local) ----
const memCache = new Map();

function hash(str) {
  // djb2, base36 — short and good enough for a cache key
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// The mode AND the provider+model are part of the key: the same text crapified
// vs decrapified must never collide, and Claude's take must not collide with
// GPT's (same model string can even repeat across vendors). Text is
// whitespace-normalized first so the same post reloaded with slightly reflowed
// whitespace still hits the persistent cache instead of paying for another call.
const fingerprint = (t) => (t || "").replace(/\s+/g, " ").trim();
function cacheKey(provider, model, mode, text) {
  return (
    CACHE_PREFIX +
    hash([provider, model, mode, fingerprint(text)].join("\u0000"))
  );
}

async function cacheGet(key) {
  if (memCache.has(key)) return memCache.get(key);
  const s = await browser.storage.local.get(key);
  if (typeof s[key] === "string") {
    memCache.set(key, s[key]);
    return s[key];
  }
  return null;
}

async function cacheSet(key, value) {
  memCache.set(key, value);
  await browser.storage.local.set({ [key]: value });
}

// Pull the contract's JSON object out of a model reply. Providers with native
// JSON mode (OpenAI, Gemini) return clean JSON; the others (Claude, MiniMax) can
// wrap it in ```json fences or add a stray word despite the prompt, so we peel
// those off before giving up.
function extractJSON(text) {
  const s = String(text || "").trim();
  try {
    return JSON.parse(s);
  } catch {}
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(s.slice(first, last + 1));
    } catch {}
  }
  throw new Error("Response was not valid JSON");
}

// Rough token budget for the whole batch. max_tokens is REQUIRED by Claude and a
// hard cap everywhere, so we scale the per-block budget by the batch size, add a
// little headroom, and clamp to something sane.
function maxTokensFor(voice, blockCount) {
  return Math.min(8192, Math.max(256, voice.maxTokensPerBlock * blockCount + 128));
}

// Whitespace-delimited word count (matches the content script's definition).
function wordCount(text) {
  const t = (text || "").trim();
  return t ? t.split(/\s+/).length : 0;
}

// ---- the one call that talks to a model ----
// blocks: [{ id, text }]. Returns a Map of id -> transformed text.
// We match by id and tolerate the model returning extra/missing/misordered
// items — unmatched inputs are simply left untouched by the caller.
// `mode` selects the voice (prompt.js); `provider` selects the backend
// (providers.js). Everything vendor-specific lives behind the provider adapter.
async function callLLM(blocks, provider, apiKey, model, mode) {
  const voice = CTC_VOICE.configFor(mode);
  const prov = CTC_PROVIDERS.configFor(provider);

  const userContent = CTC_VOICE.buildUserPayload(
    blocks.map((b) => ({ id: b.id, text: b.text }))
  );

  const { url, headers, body } = prov.buildRequest({
    apiKey,
    model,
    systemPrompt: voice.systemPrompt,
    userContent,
    temperature: voice.temperature,
    maxTokens: maxTokensFor(voice, blocks.length),
  });

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(`${prov.label} ${resp.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = prov.parseResponse(data);
  if (!content) throw new Error(`${prov.label}: empty response`);

  const parsed = extractJSON(content);
  const arr = parsed.results;
  if (!Array.isArray(arr)) throw new Error("results is not an array");

  const map = new Map();
  for (const r of arr) {
    if (r && r.id != null && r.text != null) map.set(String(r.id), String(r.text));
  }
  return map;
}

// Transform ONE batch in the given mode. Cache hits are resolved locally; only
// the misses hit the API. On API failure, the uncached blocks are simply omitted
// from results (the content script leaves those blocks untouched) — one batch
// failing never kills the page.
async function handleTransform(blocks, mode, url) {
  const { provider, apiKey, model } = await getSettings();
  const m = mode || CTC_VOICE.DEFAULT_MODE;
  log("transform request:", blocks.length, "block(s), mode:", m, "provider:", provider, "model:", model, "key set:", !!apiKey);
  if (!apiKey) return { error: "NO_API_KEY" };

  // The provider host is an optional permission granted from the settings page.
  // A legacy user who had a key before this change (or who cleared the grant)
  // may reach here without it. We can't prompt from the background (no user
  // gesture), so surface a terminal error the same way NO_API_KEY is handled —
  // the fix is to open Settings and hit Save, which requests the host.
  const prov = CTC_PROVIDERS.configFor(provider);
  if (prov.host) {
    const granted = await browser.permissions
      .contains({ origins: [prov.host] })
      .catch(() => false);
    if (!granted) return { error: "NO_HOST_PERMISSION" };
  }

  const results = [];
  const misses = [];

  for (const b of blocks) {
    const hit = await cacheGet(cacheKey(provider, model, m, b.text));
    if (hit != null) results.push({ id: b.id, text: hit });
    else misses.push(b);
  }

  log(results.length, "cache hit(s),", misses.length, "to fetch");

  if (misses.length) {
    try {
      const out = await callLLM(misses, provider, apiKey, model, m);
      let matched = 0;
      let wordsCut = 0; // decrapify shrinks
      let wordsAdded = 0; // crapify grows
      for (const b of misses) {
        const t = out.get(String(b.id));
        if (t == null) continue; // model omitted this id — leave original
        matched++;
        results.push({ id: b.id, text: t });
        await cacheSet(cacheKey(provider, model, m, b.text), t);

        // Word stats are tallied HERE, on the miss, for the same reason page
        // counts are: this is the one place we actually PAID to transform the
        // block. Cache hits (reloads, flipping back to a mode already computed)
        // are served above and never reach here, so the totals stop inflating
        // when you toggle back and forth.
        const delta = wordCount(t) - wordCount(b.text);
        if (delta < 0) wordsCut += -delta;
        else wordsAdded += delta;
      }
      log(provider, "matched", matched, "of", misses.length, "block(s) by id");

      if (wordsCut || wordsAdded) addStats({ wordsCut, wordsAdded });

      // We actually PAID for this batch (uncached API call succeeded), so this
      // page counts — once per (url, mode). A fresh uncached load counts; the
      // first time you flip to the other mode counts; reloads, scrolls, and
      // flipping back to an already-computed mode hit the cache above, never
      // reach here, and so never re-count. countPaidPage dedupes concurrent
      // batches for the same page via a synchronous in-memory gate.
      countPaidPage(url, m).catch(() => {});
    } catch (e) {
      log("LLM call FAILED:", String(e.message || e));
      return { results, error: String(e.message || e) };
    }
  }

  return { results };
}

// ---- lifetime stats (serialized read-modify-write to avoid lost updates) ----
// Text now moves in both directions, so we track cut and added words separately.
let statsChain = Promise.resolve();

// Read stats, migrating the legacy { wordsBefore, wordsAfter } schema on the way.
function normalizeStats(raw) {
  const st = raw || {};
  if (st.wordsBefore != null && st.wordsCut == null) {
    return {
      wordsCut: Math.max(0, (st.wordsBefore || 0) - (st.wordsAfter || 0)),
      wordsAdded: 0,
      pages: st.pages || 0,
    };
  }
  return {
    wordsCut: st.wordsCut || 0,
    wordsAdded: st.wordsAdded || 0,
    pages: st.pages || 0,
  };
}

// Pure accumulation, serialized to avoid lost updates. Page DEDUP is handled
// separately by countPaidPage() — do not route page counts through here.
function addStats({ wordsCut = 0, wordsAdded = 0, pages = 0 }) {
  // .catch keeps one failed link from poisoning every future stats update.
  statsChain = statsChain
    .then(async () => {
      const s = await browser.storage.local.get("stats");
      const st = normalizeStats(s.stats);
      st.wordsCut += wordsCut;
      st.wordsAdded += wordsAdded;
      st.pages += pages;
      await browser.storage.local.set({ stats: st });
    })
    .catch((e) => log("addStats failed:", String(e.message || e)));
  return statsChain;
}

// ---- paid-page counting (deduped per (url, mode)) ----
// "Pages processed" counts each (page, mode) we actually PAID to transform (an
// uncached API call). GitHub & co. trigger many overlapping scans, and each scan
// fans out into up to CONCURRENCY batches — so this can be invoked several times
// for the SAME page near-simultaneously. A storage round-trip is too slow to
// dedupe that safely (and the MV3 event page can restart mid-flight), so the
// authoritative gate is an IN-MEMORY Set checked and mutated synchronously, with
// no await between has() and add(). storage is only the durable backing so the
// count survives a background restart. We store short HASHes (fragment stripped),
// not full URLs — compact, and keeps browsing history out of storage.
const COUNTED_PAGES_KEY = "countedPages";
const COUNTED_PAGES_CAP = 20000;

const countedPagesMem = new Set(); // synchronous, race-free session gate
let countedPagesLoad = null; // shared promise: hydrate mem from storage once

function pageKey(url, mode) {
  try {
    const u = new URL(url);
    u.hash = ""; // #section changes are the same page
    return hash(u.href + "\u0000" + (mode || ""));
  } catch {
    return "";
  }
}

function ensureCountedPagesLoaded() {
  if (!countedPagesLoad) {
    countedPagesLoad = browser.storage.local
      .get(COUNTED_PAGES_KEY)
      .then((got) => {
        const seen = got[COUNTED_PAGES_KEY] || {};
        for (const k of Object.keys(seen)) countedPagesMem.add(k);
      })
      .catch(() => {});
  }
  return countedPagesLoad;
}

// Persist a newly-counted key, serialized onto statsChain to avoid lost updates.
function persistCountedPage(key) {
  statsChain = statsChain
    .then(async () => {
      const got = await browser.storage.local.get(COUNTED_PAGES_KEY);
      let seen = got[COUNTED_PAGES_KEY] || {};
      seen[key] = 1;
      // Cheap cap: if we blow the budget, start over rather than growing forever.
      // Losing dedup history just means a few very old pages might count once
      // more — harmless.
      if (Object.keys(seen).length > COUNTED_PAGES_CAP) seen = { [key]: 1 };
      await browser.storage.local.set({ [COUNTED_PAGES_KEY]: seen });
    })
    .catch((e) => log("persistCountedPage failed:", String(e.message || e)));
  return statsChain;
}

// Count a paid page exactly once per (url, mode). Safe to call concurrently.
async function countPaidPage(url, mode) {
  await ensureCountedPagesLoaded();
  const key = pageKey(url, mode);

  // No usable URL -> count it (better than silently dropping a real paid page),
  // but we can't dedupe it.
  if (!key) return addStats({ pages: 1 });

  // The has()/add() pair below is the whole point: it runs with NO await in
  // between, so two batches racing for the same page can't both get past it.
  if (countedPagesMem.has(key)) return;
  countedPagesMem.add(key);

  addStats({ pages: 1 });
  persistCountedPage(key);
}

// ---- message router ----
browser.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  // "compress" kept as the wire name for back-compat; it now carries a mode + url.
  if (msg.type === "compress") return handleTransform(msg.blocks || [], msg.mode, msg.url);
  if (msg.type === "addStats") return addStats(msg).then(() => ({ ok: true }));
  return;
});
