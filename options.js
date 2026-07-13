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

// Working copy of every provider's key/model, so switching the dropdown never
// loses what you typed for another provider before you Save.
let apiKeys = {};
let models = {};

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
  ]);

  apiKeys = { ...(store.apiKeys || {}) };
  models = { ...(store.models || {}) };

  // Fold the legacy OpenAI-only fields into the working copy.
  if (store.apiKey && !apiKeys.openai) apiKeys.openai = store.apiKey;
  if (store.model && !models.openai) models.openai = store.model;

  populateProviders();
  providerEl.value = PROVIDERS[store.provider] ? store.provider : DEFAULT_PROVIDER;
  renderProvider();
}

async function save() {
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

  await browser.storage.local.set({
    provider: providerEl.value,
    apiKeys,
    models,
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

document.getElementById("save").addEventListener("click", save);
load();
