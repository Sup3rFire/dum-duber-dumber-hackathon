// Background event page: OpenAI calls, response cache, lifetime stats.
// Loaded after lib/browser-polyfill.js and prompt.js (see manifest).
// Uses CTC_VOICE.SYSTEM_PROMPT from prompt.js.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const CACHE_PREFIX = "c:"; // storage key prefix for cached compressions

const DEBUG = true; // set false to silence
const log = (...a) => DEBUG && console.log("%c[CTC-bg]", "color:#911eb4", ...a);
log("background worker loaded");

// ---- settings ----
async function getSettings() {
  const s = await browser.storage.local.get(["apiKey", "model"]);
  return { apiKey: s.apiKey || "", model: s.model || DEFAULT_MODEL };
}

// ---- cache (in-memory + storage.local) ----
const memCache = new Map();

function hash(str) {
  // djb2, base36 — short and good enough for a cache key
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function cacheKey(model, text) {
  return CACHE_PREFIX + hash(model + "\u0000" + text);
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

// ---- OpenAI ----
// blocks: [{ id, text }]. Returns a Map of id -> compressed text.
// We match by id and tolerate the model returning extra/missing/misordered
// items — unmatched inputs are simply left uncompressed by the caller.
async function callOpenAI(blocks, apiKey, model) {
  const resp = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: CTC_VOICE.SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            blocks: blocks.map((b) => ({ id: b.id, text: b.text })),
          }),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.4,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`OpenAI ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response");

  const parsed = JSON.parse(content);
  const arr = parsed.results;
  if (!Array.isArray(arr)) throw new Error("results is not an array");

  const map = new Map();
  for (const r of arr) {
    if (r && r.id != null && r.text != null) map.set(String(r.id), String(r.text));
  }
  return map;
}

// Compress ONE batch. Cache hits are resolved locally; only the misses hit the API.
// On API failure, the uncached blocks are simply omitted from results (the content
// script leaves those blocks untouched) — one batch failing never kills the page.
async function handleCompress(blocks) {
  const { apiKey, model } = await getSettings();
  log("compress request:", blocks.length, "block(s), model:", model, "key set:", !!apiKey);
  if (!apiKey) return { error: "NO_API_KEY" };

  const results = [];
  const misses = [];

  for (const b of blocks) {
    const hit = await cacheGet(cacheKey(model, b.text));
    if (hit != null) results.push({ id: b.id, text: hit });
    else misses.push(b);
  }

  log(results.length, "cache hit(s),", misses.length, "to fetch");

  if (misses.length) {
    try {
      const out = await callOpenAI(misses, apiKey, model);
      let matched = 0;
      for (const b of misses) {
        const t = out.get(String(b.id));
        if (t == null) continue; // model omitted this id — leave original
        matched++;
        results.push({ id: b.id, text: t });
        await cacheSet(cacheKey(model, b.text), t);
      }
      log("OpenAI matched", matched, "of", misses.length, "block(s) by id");
    } catch (e) {
      log("OpenAI call FAILED:", String(e.message || e));
      return { results, error: String(e.message || e) };
    }
  }

  return { results };
}

// ---- lifetime stats (serialized read-modify-write to avoid lost updates) ----
let statsChain = Promise.resolve();

function addStats({ wordsBefore = 0, wordsAfter = 0, pages = 0 }) {
  statsChain = statsChain.then(async () => {
    const s = await browser.storage.local.get("stats");
    const st = s.stats || { wordsBefore: 0, wordsAfter: 0, pages: 0 };
    st.wordsBefore += wordsBefore;
    st.wordsAfter += wordsAfter;
    st.pages += pages;
    await browser.storage.local.set({ stats: st });
  });
  return statsChain;
}

// ---- message router ----
browser.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === "compress") return handleCompress(msg.blocks || []);
  if (msg.type === "addStats") return addStats(msg).then(() => ({ ok: true }));
  return;
});
