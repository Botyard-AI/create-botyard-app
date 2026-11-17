import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

// The UI is built to dist/client, which `npm start` serves. In development the
// Node server runs Vite as middleware (server/index.ts --dev), so the API and
// the UI share one port, as they do behind the Bot Page.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: { outDir: "dist/client", emptyOutDir: true },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
  },
})
