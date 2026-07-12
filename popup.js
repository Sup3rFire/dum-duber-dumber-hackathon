const hostEl = document.getElementById("host");
const spectrumEl = document.getElementById("spectrum");
const modeLabelEl = document.getElementById("modeLabel");
const modeSubEl = document.getElementById("modeSub");
const wordsCutEl = document.getElementById("wordsCut");
const wordsAddedEl = document.getElementById("wordsAdded");
const pagesEl = document.getElementById("pages");

let host = null;

// Slider position (0..2) -> mode, laid out as a spectrum around Normal.
const MODES = [
  "crap", // 0 — pile on the crap
  "off", // 1 — untouched
  "decrap", // 2 — cut the crap
];

const MODE_META = {
  crap: { label: "Pile on the Crap", sub: "Turns plain text into a corporate saga", cls: "crap" },
  off: { label: "Normal", sub: "Leaves the page untouched", cls: "" },
  decrap: { label: "Cut the Crap", sub: "Just the one honest sentence", cls: "decrap" },
};

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

function indexOfMode(m) {
  const i = MODES.indexOf(m);
  return i === -1 ? 1 : i;
}

function renderModeLabel(mode) {
  const meta = MODE_META[mode] || MODE_META.off;
  modeLabelEl.textContent = meta.label;
  modeSubEl.textContent = meta.sub;
  modeLabelEl.className = "mode-label" + (meta.cls ? " " + meta.cls : "");
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

async function renderSlider() {
  const mode = await currentMode();
  spectrumEl.value = String(indexOfMode(mode));
  renderModeLabel(mode);
}

async function renderStats() {
  const s = await browser.storage.local.get("stats");
  const st = s.stats || {};
  // Tolerate the legacy { wordsBefore, wordsAfter } schema.
  const cut = st.wordsCut != null ? st.wordsCut : Math.max(0, (st.wordsBefore || 0) - (st.wordsAfter || 0));
  const added = st.wordsAdded || 0;
  wordsCutEl.textContent = cut.toLocaleString();
  wordsAddedEl.textContent = added.toLocaleString();
  pagesEl.textContent = (st.pages || 0).toLocaleString();
}

async function hasApiKey() {
  const s = await browser.storage.local.get("apiKey");
  return !!(s.apiKey && s.apiKey.trim());
}

async function setMode(mode) {
  const s = await browser.storage.local.get("siteState");
  const state = s.siteState || {};
  state[host] = mode;
  await browser.storage.local.set({ siteState: state });
}

// Live label update while dragging (before commit).
spectrumEl.addEventListener("input", () => {
  renderModeLabel(MODES[Number(spectrumEl.value)]);
});

// Commit on release / change.
spectrumEl.addEventListener("change", async () => {
  if (!host) {
    spectrumEl.value = "1";
    renderModeLabel("off");
    return;
  }

  const mode = MODES[Number(spectrumEl.value)];

  // Any active mode needs a key. Missing key -> bounce to Settings, snap to Normal.
  if (mode !== "off" && !(await hasApiKey())) {
    spectrumEl.value = "1";
    renderModeLabel("off");
    browser.runtime.openOptionsPage();
    window.close();
    return;
  }

  await setMode(mode);
  renderModeLabel(mode);
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
  if (!host) spectrumEl.disabled = true;
  await renderSlider();
  await renderStats();
})();
