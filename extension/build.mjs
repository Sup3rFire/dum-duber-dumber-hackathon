// Packages the extension into a distributable zip, excluding dev-only files.
// Cross-platform replacement for the old build-zip.ps1 / build-zip.sh.
// Usage: node build.mjs   (or: npm run build --workspace=extension)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const archiver = require("archiver");

const root = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(root, "dist");

const manifest = JSON.parse(
  await readFile(path.join(root, "manifest.json"), "utf8"),
);
const name = manifest.name.replace(/\s+/g, "-").toLowerCase();
const outZip = path.join(distDir, `${name}-${manifest.version}.zip`);

// Dev-only files that must never ship inside the packaged extension.
const ignore = [
  "package.json",
  "build.mjs",
  "node_modules/**",
  "dist/**",
  "**/*.md",
  "**/*.zip",
];

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await new Promise((resolve, reject) => {
  const output = createWriteStream(outZip);
  const archive = archiver("zip", { zlib: { level: 9 } });

  output.on("close", resolve);
  archive.on("warning", (err) => {
    if (err.code === "ENOENT") console.warn(err);
    else reject(err);
  });
  archive.on("error", reject);

  archive.pipe(output);
  archive.glob("**/*", { cwd: root, dot: false, ignore });
  archive.finalize();
});

console.log(`Created ${outZip}`);
