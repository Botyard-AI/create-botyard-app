import { test } from "node:test"
import assert from "node:assert/strict"

test("placeholder module refuses to load with a not-ready message", async () => {
  await assert.rejects(import("../index.js"), /@botyard\/ui is not ready yet/)
})
