// Settings page. Backed by the multi-provider storage schema (see providers.js
// resolveSettings): { provider, apiKeys: {id: key}, models: {id: model} }.
// Legacy OpenAI-only keys (top-level `apiKey` / `model`) are read on load and
// re-saved under the new schema the first time you hit Save.

const { PROVIDERS, DEFAULT_PROVIDER, configFor } = CTC_PROVIDERS;

const providerEl = document.getElementById("provider");
const apiKeyEl = document.getElementById("apiKey");
const apiKeyLabelEl = document.getElementById("apiKeyLabel");
const apiKeyLinkEl = document.getElementById("apiKeyLink");
const modelEl = document.getElementById("model");
const modelListEl = document.getElementById("modelList");
const statusEl = document.getElementById("status");
const dataConsentEl = document.getElementById("dataConsent");
const saveEl = document.getElementById("save");

// Working copy of every provider's key/model, so switching the dropdown never
// loses what you typed for another provider before you Save.
let apiKeys = {};
let models = {};
// When consent was first given (epoch ms), or null if never given. Preserved
// across saves once set — re-saving settings doesn't reset the timestamp.
let dataConsentAt = null;

function populateProviders() {
  providerEl.replaceChildren();
  for (const p of Object.values(PROVIDERS)) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    providerEl.appendChild(opt);
  }
}

// Reflect the currently selected provider into the key/model fields + hints.
function renderProvider() {
  const prov = configFor(providerEl.value);

  apiKeyLabelEl.textContent = `${prov.label} API key`;
  apiKeyEl.placeholder = prov.apiKeyHint || "";
  apiKeyEl.value = apiKeys[prov.id] || "";

  // The "Get a key." anchor lives in options.html; just point it at the current
  // provider's key page, or hide it when the provider has no such URL.
  if (prov.apiKeyUrl) {
    apiKeyLinkEl.href = prov.apiKeyUrl;
    apiKeyLinkEl.hidden = false;
  } else {
    apiKeyLinkEl.removeAttribute("href");
    apiKeyLinkEl.hidden = true;
  }

  modelEl.value = models[prov.id] || prov.defaultModel;
  modelListEl.replaceChildren();
  for (const m of prov.models || []) {
    const opt = document.createElement("option");
    opt.value = m;
    modelListEl.appendChild(opt);
  }
  document.getElementById("modelHint").textContent = `Any ${prov.label} model. Default: ${prov.defaultModel}.`;
}

// Pull the visible fields back into the working copies for the active provider.
function captureCurrent() {
  const id = providerEl.value;
  apiKeys[id] = apiKeyEl.value.trim();
  models[id] = modelEl.value.trim();
}

async function load() {
  const store = await browser.storage.local.get([
    "provider",
    "apiKeys",
    "models",
    "apiKey",
    "model",
    "dataConsentAt",
  ]);

  apiKeys = { ...(store.apiKeys || {}) };
  models = { ...(store.models || {}) };
  dataConsentAt = store.dataConsentAt || null;

  // Fold the legacy OpenAI-only fields into the working copy.
  if (store.apiKey && !apiKeys.openai) apiKeys.openai = store.apiKey;
  if (store.model && !models.openai) models.openai = store.model;

  populateProviders();
  providerEl.value = PROVIDERS[store.provider] ? store.provider : DEFAULT_PROVIDER;
  renderProvider();

  dataConsentEl.checked = !!dataConsentAt;
  updateSaveEnabled();
}

// Save is a hard gate on consent — Chrome Web Store policy requires an
// explicit in-product opt-in (not just a privacy-policy document) before page
// text is sent to a third party, so an unchecked box blocks Save entirely
// rather than just warning after the fact.
function updateSaveEnabled() {
  saveEl.disabled = !dataConsentEl.checked;
}

async function save() {
  // Hard gate: refuse to save (and so refuse to let any site be enabled —
  // background.js checks this same flag) until the box is checked. This is
  // the "prominent disclosure" the Chrome Web Store requires to live in the
  // product's own UI, not just in the privacy policy.
  if (!dataConsentEl.checked) {
    statusEl.textContent = "Please agree to the data notice above to continue.";
    statusEl.classList.add("warn");
    return;
  }
  statusEl.classList.remove("warn");

  captureCurrent();

  // The provider hosts are optional_host_permissions, so a fresh install ships
  // with zero remote access. Request just the selected provider's host here, on
  // the Save click — permissions.request() needs a user gesture, and this is one.
  // captureCurrent() above is synchronous, so no await breaks the gesture chain.
  const prov = configFor(providerEl.value);
  if (prov.host) {
    let granted = false;
    try {
      granted = await browser.permissions.request({ origins: [prov.host] });
    } catch {
      granted = false;
    }
    if (!granted) {
      statusEl.textContent = `${prov.label} needs host access to run — not saved.`;
      return;
    }
  }

  // Only stamp the timestamp the first time — re-saving settings later (a new
  // key, a different model) shouldn't reset when consent was originally given.
  if (!dataConsentAt) dataConsentAt = Date.now();

  await browser.storage.local.set({
    provider: providerEl.value,
    apiKeys,
    models,
    dataConsentAt,
  });
  statusEl.textContent = "Saved";
  setTimeout(() => (statusEl.textContent = ""), 1500);
}

// The key/model fields are captured live on every keystroke (against whichever
// provider is selected at the time), so by the time the dropdown changes the
// previous provider's values are already stashed — we just render the new one.
apiKeyEl.addEventListener("input", captureCurrent);
modelEl.addEventListener("input", captureCurrent);
providerEl.addEventListener("change", renderProvider);
dataConsentEl.addEventListener("change", updateSaveEnabled);

saveEl.addEventListener("click", save);
load();
