const hostEl = document.getElementById("host");
const modeSelectorEl = document.getElementById("modeSelector");
const modeInputs = [...document.querySelectorAll('input[name="mode"]')];
const wordsCutEl = document.getElementById("wordsCut");
const wordsAddedEl = document.getElementById("wordsAdded");
const pagesEl = document.getElementById("pages");
const statGridEl = document.querySelector(".stat-grid");

let host = null;
let activeTabId = null; // needed to target scripting.executeScript on enable
let originPattern = null; // "*://host/*" for the active tab; null if unsupported

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

// http/https only — these are the only schemes we can request per-origin host
// access for (and the only ones content.js can be dynamically injected into).
function hostnameOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname || null;
  } catch {
    return null;
  }
}

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab || null;
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

    if (mode === "off") {
      // Disabling never needs host access — just flip the stored mode. The
      // permission granted for this origin is intentionally kept (not
      // revoked), so re-enabling later won't re-prompt.
      await setMode("off");
      renderModeSelector("off");
      return;
    }

    // Record the intent BEFORE requesting. On Firefox the host-permission
    // doorhanger is anchored outside the popup panel, so clicking Allow moves
    // focus out of the popup and Firefox closes it — killing this handler
    // mid-await, before setMode() below would ever run. Persisting the intent
    // first lets the background worker finish the enable from
    // permissions.onAdded even though this popup is gone by then.
    // NOT awaited: permissions.request must still be the first await, so it
    // stays inside the click's user-gesture window.
    browser.storage.local.set({ pendingEnable: { host, mode, tabId: activeTabId } });

    // permissions.request needs a real user gesture, and this change handler
    // IS one — so it must be the very first await.
    let granted = false;
    try {
      granted = await browser.permissions.request({ origins: [originPattern] });
    } catch {
      granted = false;
    }
    if (!granted) {
      // Only reached if the popup survived (denied, or an in-panel prompt).
      // Drop the recorded intent and snap the selector back.
      browser.storage.local.remove("pendingEnable");
      renderModeSelector("off");
      return;
    }

    // Granted with the popup still alive — typically an already-granted
    // origin (re-enabling after a prior "off"), which shows no doorhanger and
    // so never fires permissions.onAdded. Nudge the background to complete
    // now. Fire-and-forget: closing the popup doesn't cancel an in-flight
    // message, and the API-key gate + siteState write now live in the
    // background (doCompleteEnable) so they run there either way.
    browser.runtime.sendMessage({ type: "completeEnable" }).catch(() => {});
    // Don't optimistically flip the selector here — the background may still
    // bounce this to Settings for a missing key. The storage.onChanged
    // listener below re-renders it once siteState actually changes.
  });
});

document.getElementById("openOptions").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

// Live-update while the popup is open: stats change as usual, and siteState
// changes whenever the background finishes an enable (completeEnable) after
// this popup fired the permission request — possibly on a Firefox doorhanger
// where THIS popup instance already died and a fresh one is now open.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.stats) renderStats();
  if (changes.siteState) renderModeSelectorFromStorage();
});

(async function init() {
  const tab = await getActiveTab();
  host = tab ? hostnameOf(tab.url) : null;
  activeTabId = tab ? tab.id : null;
  originPattern = host ? `*://${host}/*` : null;
  hostEl.textContent = host || "(unsupported page)";
  if (!host) modeSelectorEl.disabled = true;
  await renderModeSelectorFromStorage();
  await renderStats();
})();
