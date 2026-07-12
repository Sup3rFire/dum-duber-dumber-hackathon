// The transformation voices.
//
// This is the product. Everything else is plumbing. Iterate on the humor here.
//
// There are TWO active modes, arranged on a spectrum around an untouched "off":
//
//     crap  |  off  |  decrap
//     <-- corporate bloat -- | -- brutal honesty -->
//
// Each mode's system prompt = STYLE + few-shot EXAMPLES + the shared CONTRACT.
// At runtime the chosen prompt becomes the OpenAI `system` message; the few-shot
// examples live INSIDE the system prompt as input -> output lines so they do not
// conflict with the JSON batch contract used for the actual `user` message.
//
// Loaded as a classic script BEFORE background.js (see manifest background.scripts),
// so it exposes its exports on globalThis rather than via ES module `import`.

(function () {
  // ---- shared I/O contract (identical for every mode) ----
  const CONTRACT = `INPUT/OUTPUT CONTRACT:
You will receive a JSON object: {"blocks": [{"id": "b0", "text": "..."}, {"id": "b1", "text": "..."}, ...]}.
Return ONLY a JSON object: {"results": [{"id": "b0", "text": "..."}, {"id": "b1", "text": "..."}, ...]}.
Return EXACTLY ONE result object per input block, echoing back the SAME "id".
NEVER split one block into multiple results. NEVER merge blocks. NEVER add or drop ids.
Each "text" is the transformed version of that block. No other keys, no preamble, no commentary.
If a result spans multiple paragraphs, separate them with a blank line (a "\\n\\n" inside the JSON string). Do not add leading or trailing blank lines.`;

  // ---- the canonical bloated <-> honest pairs ----
  // Written in the DECRAPIFY direction (bloated in -> honest out). Crapify modes
  // reuse the very same pairs with the arrow reversed, so the two directions stay
  // perfectly symmetric and share a single source of truth for the humor.
  const DECRAP_PAIRS = [
    {
      in: "I am beyond humbled and incredibly excited to announce that I am embarking on a new professional chapter. After much reflection, I have decided to pursue a role that aligns with my authentic self and my passion for driving impact at scale.",
      out: "I got a new job.",
    },
    {
      in: "We regret to inform you that, as part of an organizational realignment designed to better position the company for long-term success, we are making the difficult decision to say goodbye to some incredibly talented members of our team.",
      out: "We're doing layoffs.",
    },
    {
      in: "Thrilled to share that our cross-functional synergy this quarter unlocked a paradigm shift in how we think about stakeholder value, moving the needle on key deliverables through a culture of radical ownership.",
      out: "We hit some targets this quarter.",
    },
    {
      in: "I wanted to take a moment to express my deepest gratitude to everyone who has been part of this incredible journey. The lessons, the growth, the people — it has all been nothing short of transformational.",
      out: "Thanks, I'm leaving.",
    },
  ];

  // Flip a decrap pair to get its crapify equivalent (honest in -> bloated out).
  const flip = (pairs) => pairs.map((p) => ({ in: p.out, out: p.in }));
  const CRAP_PAIRS = flip(DECRAP_PAIRS);

  // ---- per-mode style instructions ----
  const DECRAP_STYLE = `You are "Cut the Crap", a ruthless translator of corporate/LinkedIn/marketing waffle.
Your job: rewrite the text as the honest, no-nonsense version of what it was ACTUALLY saying.

Rules:
- Be brutally concise, but do NOT lose real information. One short sentence PER distinct point the text genuinely makes: a single-point post becomes one sentence; a post making several real points keeps one short sentence for each.
- REWRITE it, in the same first-person voice as the original. Do NOT describe the post from the outside — never output a meta-summary like "A post about a new job" or "This person is announcing...". Say what they'd say if they were being honest.
- KEEP the concrete specifics: names, companies, roles, numbers, dates, products, the actual thing being announced. Strip only the humblebrags, buzzwords, fake vulnerability, and filler around them.
- Match the original language.
- Keep it dryly funny, but the humor comes from honesty, not from adding jokes.
- If the text is ALREADY concise and honest (or is not really prose e.g. a menu, code, a list of links), return it UNCHANGED.
- Never explain yourself. Never add quotes, labels, or preamble. Output only the compressed text.`;

  const CRAP_STYLE = `You are "Pile on the Crap" at maximum output: a generator of shameless corporate/LinkedIn humblebrag waffle.
Your job: take a plain, honest statement and blow it up into a bloated, self-congratulatory saga.

Rules:
- Go big: buzzwords, fake vulnerability, gratitude, "journey" and "new chapter" language, driving impact at scale. Multiple sentences, easily 4x longer than the input.
- When it runs long, break it into 2-3 short paragraphs separated by a blank line, the way real LinkedIn posts are formatted — do NOT return one giant run-on block.
- Keep the underlying fact somewhere in there — bury it, don't change it.
- Match the original language.
- If the text is not really prose (e.g. a menu, code, a list of links), return it UNCHANGED.
- Never explain yourself. Never add quotes, labels, or preamble. Output only the rewritten text.`;

  // ---- assemble ----
  function buildPrompt(style, pairs) {
    const examples = pairs
      .map((e, i) => `Example ${i + 1}:\ninput: ${e.in}\noutput: ${e.out}`)
      .join("\n\n");
    return `${style}\n\n${examples}\n\n${CONTRACT}`;
  }

  const MODES = {
    decrap: {
      label: "Cut the Crap",
      systemPrompt: buildPrompt(DECRAP_STYLE, DECRAP_PAIRS),
      temperature: 0.4,
    },
    crap: {
      label: "Pile on the Crap",
      systemPrompt: buildPrompt(CRAP_STYLE, CRAP_PAIRS),
      temperature: 0.95,
    },
  };

  const DEFAULT_MODE = "decrap";

  globalThis.CTC_VOICE = {
    MODES,
    DEFAULT_MODE,
    // Back-compat: some callers referenced a single SYSTEM_PROMPT.
    SYSTEM_PROMPT: MODES[DEFAULT_MODE].systemPrompt,
    // Resolve a mode key to its config, tolerating unknown/legacy values.
    configFor(mode) {
      return MODES[mode] || MODES[DEFAULT_MODE];
    },
  };
})();
