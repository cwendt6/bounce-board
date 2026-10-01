import { resolve } from "node:path";
import { defineConfig } from "vite";

// GitHub Pages serves the site under /bounce-board/.
export default defineConfig({
  base: process.env.PAGES_BASE ?? "/",
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        admin: resolve(import.meta.dirname, "admin.html"),
      },
    },
  },
});
