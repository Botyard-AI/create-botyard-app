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
  server: {
    fs: {
      // Files the dev server must never send. A list here replaces Vite's own
      // defaults, so they are repeated first (Vite 8). The app's data/ holds
      // its trace and any stores: the dev server serves files under the
      // app's root, and `npm run dev` can be published as a Bot Page.
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem,key,p12,pfx,cer,der}",
        ".npmrc",
        ".yarnrc.yml",
        "**/.git/**",
        `${path.resolve(import.meta.dirname, "data")}/**`,
      ],
    },
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
  },
})
