import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { devApiPlugin } from "./backend/dev-api-plugin.js";

export default defineConfig(({ mode }) => ({
  plugins: [react(), devApiPlugin()],
  publicDir: false,
  build: {
    outDir: mode === "demo" ? "dist-demo" : "dist",
    emptyOutDir: true,
  },
}));
