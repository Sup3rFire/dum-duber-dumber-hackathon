const DEFAULT_MODEL = "gpt-4o-mini";

const apiKeyEl = document.getElementById("apiKey");
const modelEl = document.getElementById("model");
const statusEl = document.getElementById("status");

async function load() {
  const s = await browser.storage.local.get(["apiKey", "model"]);
  apiKeyEl.value = s.apiKey || "";
  modelEl.value = s.model || DEFAULT_MODEL;
}

async function save() {
  await browser.storage.local.set({
    apiKey: apiKeyEl.value.trim(),
    model: modelEl.value.trim() || DEFAULT_MODEL,
  });
  statusEl.textContent = "Saved";
  setTimeout(() => (statusEl.textContent = ""), 1500);
}

document.getElementById("save").addEventListener("click", save);
load();
