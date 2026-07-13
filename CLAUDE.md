# Privacy-sensitive changes — stop and flag first

This extension's privacy story: no `<all_urls>`, no page text/URLs persisted,
no telemetry, BYOK (key sent only to that provider).

Before changing any of these, **stop, state the privacy impact, propose a
narrower alternative, wait for confirmation**:

- `manifest.json` permissions — new entries in `permissions`,
  `optional_host_permissions`, or a static `content_scripts` block.
- New network destinations for page content, URLs, or user data.
- New `storage.local`/`storage.sync` fields beyond settings, API keys,
  `siteState`, `stats`. Page text and URLs must stay in-memory only
  (`memCache`, `countedSessions` in background.js).
- `storage.sync` instead of `storage.local`.
- Injection running on a site the user hasn't enabled.
- Unvendored third-party/CDN scripts (`lib/browser-polyfill.js` is vendored
  on purpose).
- New required (vs. optional, gesture-requested) permissions.

UI, `prompt.js`, `providers.js`, or in-memory-only caching changes don't need
this — default to flagging when unsure.
