// Background event page: LLM calls, response cache, lifetime stats.
// Loaded after lib/browser-polyfill.js, prompt.js and providers.js (see manifest).
// Uses CTC_VOICE.configFor(mode) from prompt.js to pick the right voice, and
// CTC_PROVIDERS.configFor(provider) to pick the right backend (OpenAI / Claude /
// Gemini / MiniMax). The message shape sent to the model is identical for every
// provider — only the HTTP envelope differs (see providers.js).

const CACHE_PREFIX = "c:"; // storage key prefix for cached transformations

const DEBUG = false; // set false to silence
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

// ---- cache (in-memory only — rewritten page text is never written to disk) ----
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
// whitespace still hits the in-memory cache instead of paying for another call.
const fingerprint = (t) => (t || "").replace(/\s+/g, " ").trim();
function cacheKey(provider, model, mode, text) {
  return (
    CACHE_PREFIX +
    hash([provider, model, mode, fingerprint(text)].join("\u0000"))
  );
}

// RAM only — rewritten page text is never persisted to storage.local, so it
// doesn't outlive the background worker (cleared on browser restart / worker
// eviction) and never touches disk.
async function cacheGet(key) {
  return memCache.has(key) ? memCache.get(key) : null;
}

async function cacheSet(key, value) {
  memCache.set(key, value);
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
async function handleTransform(blocks, mode, session) {
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

  // The extension is actively running on this page-load in this mode (past the
  // no-key / no-host guards above), so it counts — once per (session, mode),
  // regardless of whether the blocks below are served from cache or paid for.
  // A refresh or a new tab mints a fresh session and so counts again.
  countSessionPage(session, m);

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
// separately by countSessionPage() — do not route page counts through here.
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

// ---- page counting (deduped per page-load, in-memory only) ----
// "Pages processed" counts each (page-load, mode) the extension actively ran
// on. The content script mints a fresh random session id per page load (a new
// id on every refresh or new tab — see PAGE_SESSION in content.js) and sends
// no URL at all, so nothing page-identifying is ever stored. GitHub & co.
// trigger many overlapping scans, and each scan fans out into up to
// CONCURRENCY batches — so this can be invoked several times for the SAME
// page-load near-simultaneously. The gate is an IN-MEMORY Set checked and
// mutated synchronously, with no await between has() and add(), so racing
// batches can't double-count. This dedup set is NOT persisted — only the
// running total (stats.pages, via addStats) is, and that's a plain number.
// Losing the set on a background restart just means a mid-flight page-load
// might count once more — harmless, and still bounded by the cap below.
const COUNTED_SESSIONS_CAP = 20000;
const countedSessions = new Set(); // "<session> <mode>" seen this worker life

// Count a page-load exactly once per mode. Safe to call concurrently.
function countSessionPage(session, mode) {
  // No usable session -> count it (better than silently dropping a real
  // page-load), but we can't dedupe it.
  if (!session) return void addStats({ pages: 1 });

  const key = session + " " + (mode || "");
  if (countedSessions.has(key)) return;
  // Cheap cap: if we blow the budget, start over rather than growing forever.
  // Losing dedup history just means a few very old page-loads might count
  // once more — harmless.
  if (countedSessions.size >= COUNTED_SESSIONS_CAP) countedSessions.clear();
  countedSessions.add(key);

  addStats({ pages: 1 });
}

// ---- per-site content-script injection ----
// There is no static <all_urls> content script (see manifest.json) — instead
// content.js is injected only into origins the user has actually enabled, so
// the extension never carries a blanket "read and change all your data on all
// websites" grant. popup.js requests host access for one origin at a time (on
// the enabling click, so it's a real user gesture); completing the enable
// (writing siteState + injecting the CURRENT tab) happens here in the
// background via completeEnable() below, because the popup itself may not
// survive long enough to do it (see that section for why). For every
// SUBSEQUENT load of an enabled site (reload, new tab), the tabs.onUpdated
// listener further down re-derives "should this inject?" fresh from siteState
// + the live permission grant — no persistent registration to keep in sync,
// nothing extra to reconcile on install/startup.

// Mirrors content.js's normalizeMode: which stored values count as "on".
// Legacy values (`true`, the old 5-stop keys) are folded in the same way.
function isEnabledMode(v) {
  if (v === true) return true; // legacy boolean
  return typeof v === "string" && (v.startsWith("decrap") || v.startsWith("crap"));
}

// http/https only — the only schemes we ever hold host permission for.
function hostnameOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname || null;
  } catch {
    return null;
  }
}

// Bring a tab to life immediately (used both by doCompleteEnable, for the
// enabling click, and by maybeActivateOnLoad, for a qualifying navigation
// below). If a script is already resident the data-ctcLoaded guard in
// content.js makes a repeat injection a harmless no-op.
async function injectContentScript(tabId) {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["lib/browser-polyfill.js", "content.js"],
    });
  } catch (e) {
    log("executeScript failed:", String(e.message || e));
  }
}

// ---- completing an enable started in the popup ----
// The popup can't reliably finish enabling a NEW site itself: on Firefox the
// host-permission doorhanger is anchored outside the popup panel, so clicking
// Allow closes the popup and kills its handler before it can write siteState.
// So the popup only records { host, mode, tabId } in pendingEnable and fires
// the request; we finish the job here, in the background worker, which stays
// alive regardless of what happens to the popup. Serialized so the two
// triggers below (a fresh grant's permissions.onAdded; an already-granted
// re-enable's explicit message) can't race into a double-apply.
let enableChain = Promise.resolve();
function completeEnable() {
  enableChain = enableChain
    .then(doCompleteEnable)
    .catch((e) => log("completeEnable failed:", String(e.message || e)));
  return enableChain;
}

async function doCompleteEnable() {
  const s = await browser.storage.local.get(["pendingEnable", "siteState"]);
  const pending = s.pendingEnable;
  if (!pending || !pending.host) return;

  // Confirm the grant actually landed — covers a denied request that still
  // reached us, and filters out permissions.onAdded firing for an unrelated
  // origin (e.g. a provider host just granted from Settings).
  const pattern = `*://${pending.host}/*`;
  const granted = await browser.permissions
    .contains({ origins: [pattern] })
    .catch(() => false);
  if (!granted) return;

  // Consume the intent up front so a second trigger (both onAdded and the
  // popup message can fire for the same enable) is a harmless no-op.
  await browser.storage.local.remove("pendingEnable");

  // Same key gate the popup used to run before it could finish an enable
  // itself. Missing key -> open Settings and leave the site on Normal; the
  // permission stays granted, so re-enabling after adding a key won't re-prompt.
  const { apiKey } = await getSettings();
  if (!apiKey) {
    browser.runtime.openOptionsPage();
    return;
  }

  const state = s.siteState || {};
  state[pending.host] = pending.mode;
  await browser.storage.local.set({ siteState: state });

  if (pending.tabId != null) injectContentScript(pending.tabId);
}

// A fresh grant fires this even though the popup that requested it has
// already closed (the Firefox doorhanger-closes-the-popup case).
browser.permissions.onAdded.addListener(() => completeEnable());

// Fires on every page load. tab.url is only visible to us here for origins we
// already hold host permission for (Chrome/Firefox strip it otherwise), so
// this is naturally a no-op for every site we have no business touching.
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  maybeActivateOnLoad(tabId, tab && tab.url).catch((e) =>
    log("maybeActivateOnLoad failed:", String(e.message || e))
  );
});

// Re-derives injection from scratch on each load: is this site enabled, and
// do we still hold the permission it needs? If the grant is gone — revoked
// outside the extension, or siteState predates this permission model — try
// requesting it (works if this happens to run in a user-gesture context; a
// background tab-load event usually isn't one, so this is best-effort), and
// if that fails too, revert the site to Normal so stored state matches
// reality instead of silently going dark. Re-enabling from the popup will
// re-request cleanly.
async function maybeActivateOnLoad(tabId, url) {
  const host = hostnameOf(url);
  if (!host) return;

  const s = await browser.storage.local.get("siteState");
  const state = s.siteState || {};
  if (!isEnabledMode(state[host])) return;

  const pattern = `*://${host}/*`;
  let granted = await browser.permissions.contains({ origins: [pattern] }).catch(() => false);

  if (!granted) {
    try {
      granted = await browser.permissions.request({ origins: [pattern] });
    } catch {
      granted = false;
    }
  }

  if (!granted) {
    state[host] = "off";
    await browser.storage.local.set({ siteState: state });
    return;
  }

  await injectContentScript(tabId);
}

// ---- message router ----
browser.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  // "compress" kept as the wire name for back-compat; it now carries a mode +
  // per-page-load session id (no URL).
  if (msg.type === "compress") return handleTransform(msg.blocks || [], msg.mode, msg.session);
  if (msg.type === "addStats") return addStats(msg).then(() => ({ ok: true }));
  if (msg.type === "completeEnable") return completeEnable();
  return;
});
