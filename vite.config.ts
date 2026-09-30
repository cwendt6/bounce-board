import { defineConfig } from "vite";

// GitHub Pages serves the site under /bounce-board/.
export default defineConfig({
  base: process.env.PAGES_BASE ?? "/",
});
