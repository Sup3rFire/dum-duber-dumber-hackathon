// Provider registry: one LLM backend per entry.
//
// The extension speaks a SINGLE internal contract (a JSON batch of blocks in,
// a JSON batch of results out — see prompt.js CONTRACT). Every provider here is
// just an adapter that maps that contract onto a specific vendor's HTTP shape:
//   buildRequest()  -> { url, headers, body }   (body is a plain object)
//   parseResponse() -> the model's raw text (still the JSON string of the contract)
//
// Adding a provider = adding one entry here + one host in manifest host_permissions.
// Nothing else in the extension needs to know which vendor is behind the call.
//
// Loaded as a classic script (globalThis export) BEFORE background.js, and also
// pulled in directly by options.html so the settings page shares the same list.

(function () {
  // Native JSON mode is the exception, not the rule: only OpenAI + Gemini let us
  // pin the response to a JSON object. For the rest we lean on the CONTRACT in the
  // system prompt plus one extra nudge, and parse tolerantly (extractJSON in
  // background.js strips fences / preambles). This line is that nudge.
  const JSON_NUDGE =
    "\n\nCRITICAL OUTPUT FORMAT: respond with ONLY the raw JSON object described above. No markdown code fences, no ```json, no commentary before or after. The very first character of your reply must be { and the very last must be }.";

  const PROVIDERS = {
    // ---- OpenAI (GPT) — the original backend ----
    openai: {
      id: "openai",
      label: "OpenAI (GPT)",
      apiKeyHint: "sk-...",
      apiKeyUrl: "https://platform.openai.com/api-keys",
      defaultModel: "gpt-4o-mini",
      models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "o4-mini"],
      buildRequest({ apiKey, model, systemPrompt, userContent, temperature, maxTokens }) {
        return {
          url: "https://api.openai.com/v1/chat/completions",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: {
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userContent },
            ],
            response_format: { type: "json_object" },
            temperature,
            max_tokens: maxTokens,
          },
        };
      },
      parseResponse: (data) => data?.choices?.[0]?.message?.content,
    },

    // ---- Anthropic (Claude) ----
    // System prompt is a top-level field (not a message). max_tokens is REQUIRED
    // and is a hard cap. No native JSON mode, so we append JSON_NUDGE. The
    // "dangerous-direct-browser-access" header opts into CORS for BYOK use.
    anthropic: {
      id: "anthropic",
      label: "Anthropic (Claude)",
      apiKeyHint: "sk-ant-...",
      apiKeyUrl: "https://console.anthropic.com/settings/keys",
      defaultModel: "claude-3-5-haiku-latest",
      models: [
        "claude-3-5-haiku-latest",
        "claude-3-5-sonnet-latest",
        "claude-sonnet-4-5",
        "claude-opus-4-5",
      ],
      buildRequest({ apiKey, model, systemPrompt, userContent, temperature, maxTokens }) {
        return {
          url: "https://api.anthropic.com/v1/messages",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: {
            model,
            system: systemPrompt + JSON_NUDGE,
            messages: [{ role: "user", content: userContent }],
            max_tokens: maxTokens,
            temperature,
          },
        };
      },
      // content is an array of blocks; concatenate the text parts.
      parseResponse: (data) =>
        Array.isArray(data?.content)
          ? data.content.map((c) => c?.text || "").join("")
          : undefined,
    },

    // ---- Google (Gemini) ----
    // Key goes in a header; model goes in the URL path. Native JSON mode via
    // responseMimeType. System prompt is system_instruction.
    google: {
      id: "google",
      label: "Google (Gemini)",
      apiKeyHint: "AIza...",
      apiKeyUrl: "https://aistudio.google.com/apikey",
      defaultModel: "gemini-2.5-flash",
      models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-2.0-flash"],
      buildRequest({ apiKey, model, systemPrompt, userContent, temperature, maxTokens }) {
        return {
          url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            model
          )}:generateContent`,
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: {
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: userContent }] }],
            generationConfig: {
              temperature,
              responseMimeType: "application/json",
              maxOutputTokens: maxTokens,
            },
          },
        };
      },
      parseResponse: (data) =>
        data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join(""),
    },

    // ---- MiniMax ----
    // OpenAI-compatible chat completions endpoint. No reliable JSON mode, so we
    // append JSON_NUDGE and parse tolerantly.
    minimax: {
      id: "minimax",
      label: "MiniMax",
      apiKeyHint: "eyJ... (JWT)",
      apiKeyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
      defaultModel: "MiniMax-M2.5",
      models: ["MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M3", "MiniMax-M2"],
      buildRequest({ apiKey, model, systemPrompt, userContent, temperature, maxTokens }) {
        return {
          url: "https://api.minimax.io/v1/chat/completions",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: {
            model,
            messages: [
              { role: "system", content: systemPrompt + JSON_NUDGE },
              { role: "user", content: userContent },
            ],
            temperature,
            max_tokens: maxTokens,
          },
        };
      },
      parseResponse: (data) => data?.choices?.[0]?.message?.content,
    },
  };

  const DEFAULT_PROVIDER = "openai";

  const configFor = (id) => PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];

  // ---- shared settings resolution (background AND popup rely on this) ----
  // Storage schema:
  //   provider : string                       — active provider id
  //   apiKeys  : { [providerId]: string }      — one key per provider
  //   models   : { [providerId]: string }      — one model per provider
  // Legacy (OpenAI-only) schema is migrated on read: the old top-level `apiKey`
  // and `model` are treated as OpenAI's key/model.
  function resolveSettings(store) {
    const s = store || {};
    const provider = PROVIDERS[s.provider] ? s.provider : DEFAULT_PROVIDER;
    const apiKeys = s.apiKeys || {};
    const models = s.models || {};

    let apiKey = apiKeys[provider] || "";
    let model = models[provider] || "";

    // Legacy fold-in for OpenAI users who saved before providers existed.
    if (provider === "openai") {
      if (!apiKey && s.apiKey) apiKey = s.apiKey;
      if (!model && s.model) model = s.model;
    }

    return {
      provider,
      apiKey: apiKey.trim ? apiKey.trim() : apiKey,
      model: (model || configFor(provider).defaultModel).trim(),
    };
  }

  globalThis.CTC_PROVIDERS = {
    PROVIDERS,
    DEFAULT_PROVIDER,
    configFor,
    resolveSettings,
  };
})();
