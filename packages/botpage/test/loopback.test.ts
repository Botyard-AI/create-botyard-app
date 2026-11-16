import assert from "node:assert/strict"
import { test } from "vitest"

import { isLoopbackAddress } from "../src/index.ts"

test("loopback addresses", () => {
  for (const address of [
    "127.0.0.1",
    "127.1.2.3",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
    "localhost",
    "LOCALHOST",
  ]) {
    assert.equal(isLoopbackAddress(address), true, address)
  }
})

test("wildcards and other addresses are not loopback", () => {
  for (const address of [
    "0.0.0.0",
    "::",
    "10.0.0.5",
    "128.0.0.1",
    "127.0.0.256",
    "127.0.0",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isLoopbackAddress(address), false, String(address))
  }
})
