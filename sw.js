// Chrome MV3 service-worker entry point.
//
// Chrome's MV3 background is a single service worker, not the array of scripts
// that Firefox's `background.scripts` allows. This file is that single worker:
// it pulls in the same three classic scripts, in the same order the manifest
// lists for Firefox, so background.js still finds the browser polyfill and
// CTC_VOICE (from prompt.js) already on globalThis by the time it runs.
importScripts("lib/browser-polyfill.js", "prompt.js", "background.js");
