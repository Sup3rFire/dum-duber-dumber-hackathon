import { defineConfig } from "vite";

// Plain static site (HTML + CSS + assets in public/). Builds to `dist/`,
// which is a self-contained static folder deployable to Cloudflare Pages.
export default defineConfig({
  root: ".",
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
