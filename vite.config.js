import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(__dirname, "web"),
  plugins: [vue()],
  server: {
    // When running vite alone; API is usually via server/index.js
    proxy: {
      "/api": "http://localhost:5173",
    },
  },
  build: {
    outDir: path.join(__dirname, "web", "dist"),
    emptyOutDir: true,
  },
});
