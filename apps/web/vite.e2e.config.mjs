import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxy = {
  target: "http://127.0.0.1:8788",
  changeOrigin: false
};

export default defineConfig({
  plugins: [react()],
  preview: {
    port: 4174,
    strictPort: true,
    proxy: {
      "/api": { ...apiProxy },
      "/health": { ...apiProxy }
    }
  }
});
