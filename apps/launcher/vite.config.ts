import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  root: "ui",
  base: "./",
  clearScreen: false,
  build: { outDir: "../dist", emptyOutDir: true, assetsInlineLimit: 0 },
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
});
