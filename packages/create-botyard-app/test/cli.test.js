import { test } from "vitest"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const bin = fileURLToPath(new URL("../bin/create-botyard-app.js", import.meta.url))

test("placeholder CLI explains it is not ready and exits non-zero", () => {
  const result = spawnSync(process.execPath, [bin], { encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not ready yet/)
  assert.equal(result.stdout, "")
})
