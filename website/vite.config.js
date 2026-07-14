import { defineConfig } from "vite";
import { resolve } from "path";

// Plain static site (HTML + CSS + assets in public/). Builds to `dist/`,
// which is a self-contained static folder deployable to Cloudflare Pages.
// Multi-page: Vite only builds index.html by default, so privacy.html needs
// an explicit rollup input to be emitted too.
export default defineConfig({
  root: ".",
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        privacy: resolve(__dirname, "privacy.html"),
      },
    },
  },
});
