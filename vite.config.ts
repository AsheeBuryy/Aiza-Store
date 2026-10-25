import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { devApiPlugin } from "./backend/dev-api-plugin.js";

export default defineConfig({
  plugins: [react(), devApiPlugin()],
});
