import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxy = {
  target: "http://127.0.0.1:8787",
  changeOrigin: false
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { ...apiProxy },
      "/health": { ...apiProxy }
    }
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": { ...apiProxy },
      "/health": { ...apiProxy }
    }
  }
});
