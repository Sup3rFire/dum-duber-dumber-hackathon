const hostEl = document.getElementById("host");
const modeSelectorEl = document.getElementById("modeSelector");
const modeInputs = [...document.querySelectorAll('input[name="mode"]')];
const wordsCutEl = document.getElementById("wordsCut");
const wordsAddedEl = document.getElementById("wordsAdded");
const pagesEl = document.getElementById("pages");
const statGridEl = document.querySelector(".stat-grid");

let host = null;

const MODES = ["crap", "off", "decrap"];

// Map any stored value (including legacy 5-stop keys and the old boolean) to a
// current mode key.
function normalizeMode(v) {
  if (v === true) return "decrap"; // legacy boolean
  if (typeof v === "string") {
    if (v.startsWith("decrap")) return "decrap";
    if (v.startsWith("crap")) return "crap";
    if (MODES.includes(v)) return v;
  }
  return "off";
}

function renderModeSelector(mode) {
  const selected = modeInputs.find((input) => input.value === mode) || modeInputs[1];
  selected.checked = true;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function getActiveHost() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab ? hostnameOf(tab.url) : null;
}

async function currentMode() {
  const s = await browser.storage.local.get("siteState");
  const state = s.siteState || {};
  return host ? normalizeMode(state[host]) : "off";
}

async function renderModeSelectorFromStorage() {
  renderModeSelector(await currentMode());
}

// Full commas stay satisfying up to six figures; past a million we switch to
// compact notation ("3.2M", "12M", "1.4B") so the display never blows up.
const compactFmt = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
function formatStat(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  return n < 1_000_000 ? n.toLocaleString() : compactFmt.format(n);
}

// Size all three numbers off the widest one so they stay proportional, rather
// than sizing each independently (which left a huge "121" next to two shrunken
// five-digit totals).
function sizeStatGrid(labels) {
  const widest = Math.max(...labels.map((s) => s.length));
  statGridEl.classList.toggle("tier-md", widest >= 5 && widest <= 6);
  statGridEl.classList.toggle("tier-sm", widest >= 7);
}

async function renderStats() {
  const s = await browser.storage.local.get("stats");
  const st = s.stats || {};
  // Tolerate the legacy { wordsBefore, wordsAfter } schema.
  const cut = st.wordsCut != null ? st.wordsCut : Math.max(0, (st.wordsBefore || 0) - (st.wordsAfter || 0));
  const added = st.wordsAdded || 0;

  const labels = [formatStat(cut), formatStat(added), formatStat(st.pages || 0)];
  [wordsCutEl, wordsAddedEl, pagesEl].forEach((el, i) => (el.textContent = labels[i]));
  sizeStatGrid(labels);
}

// Any active mode needs a key for the CURRENTLY SELECTED provider, so resolve
// through the same schema the background worker uses rather than peeking at the
// legacy top-level `apiKey`.
async function hasApiKey() {
  const store = await browser.storage.local.get([
    "provider",
    "apiKeys",
    "models",
    "apiKey",
    "model",
  ]);
  return !!CTC_PROVIDERS.resolveSettings(store).apiKey;
}

async function setMode(mode) {
  const s = await browser.storage.local.get("siteState");
  const state = s.siteState || {};
  state[host] = mode;
  await browser.storage.local.set({ siteState: state });
}

modeInputs.forEach((input) => {
  input.addEventListener("change", async () => {
    if (!input.checked) return;

    if (!host) {
      renderModeSelector("off");
      return;
    }

    const mode = input.value;

    // Any active mode needs a key. Missing key -> bounce to Settings, snap to Normal.
    if (mode !== "off" && !(await hasApiKey())) {
      renderModeSelector("off");
      browser.runtime.openOptionsPage();
      window.close();
      return;
    }

    await setMode(mode);
    renderModeSelector(mode);
  });
});

document.getElementById("openOptions").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

// Live-update stats while the popup is open.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.stats) renderStats();
});

(async function init() {
  host = await getActiveHost();
  hostEl.textContent = host || "(unsupported page)";
  if (!host) modeSelectorEl.disabled = true;
  await renderModeSelectorFromStorage();
  await renderStats();
})();
