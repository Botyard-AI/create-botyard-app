import { defineConfig } from "vitest/config"

// One Vitest run over every package. Each package is a project with Vitest's
// defaults, so `pnpm --dir packages/<name> test` runs the same tests alone.
// Templates pin their own Vitest, so `pnpm test` runs them separately.
export default defineConfig({
  test: {
    projects: ["packages/*"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**"],
    },
  },
})
