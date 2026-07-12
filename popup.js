const hostEl = document.getElementById("host");
const toggleEl = document.getElementById("toggle");
const wordsCutEl = document.getElementById("wordsCut");
const pagesEl = document.getElementById("pages");
const percentEl = document.getElementById("percent");

let host = null;

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

async function renderToggle() {
  const s = await browser.storage.local.get("siteState");
  const state = s.siteState || {};
  toggleEl.checked = host ? state[host] === true : false;
}

async function renderStats() {
  const s = await browser.storage.local.get("stats");
  const st = s.stats || { wordsBefore: 0, wordsAfter: 0, pages: 0 };
  const cut = Math.max(0, st.wordsBefore - st.wordsAfter);
  wordsCutEl.textContent = cut.toLocaleString();
  pagesEl.textContent = st.pages.toLocaleString();
  const pct =
    st.wordsBefore > 0
      ? Math.round((1 - st.wordsAfter / st.wordsBefore) * 100)
      : 0;
  percentEl.textContent = pct + "%";
}

async function hasApiKey() {
  const s = await browser.storage.local.get("apiKey");
  return !!(s.apiKey && s.apiKey.trim());
}

toggleEl.addEventListener("change", async () => {
  if (!host) {
    toggleEl.checked = false;
    return;
  }

  // Turning ON without an API key -> send to options instead of failing silently.
  if (toggleEl.checked && !(await hasApiKey())) {
    toggleEl.checked = false;
    browser.runtime.openOptionsPage();
    window.close();
    return;
  }

  const s = await browser.storage.local.get("siteState");
  const state = s.siteState || {};
  state[host] = toggleEl.checked;
  await browser.storage.local.set({ siteState: state });
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
  if (!host) toggleEl.disabled = true;
  await renderToggle();
  await renderStats();
})();
