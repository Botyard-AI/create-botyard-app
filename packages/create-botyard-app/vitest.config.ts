import { defineProject } from "vitest/config"

export default defineProject({
  // templates/ is the bundled build output; each template runs its own tests.
  test: { name: "create-botyard-app", exclude: ["**/node_modules/**", "templates/**"] },
})
