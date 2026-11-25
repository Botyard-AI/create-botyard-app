// Some blocks also ship inside the template, so a new app has them before any
// `shadcn add`. The two copies must stay byte for byte the same: otherwise an
// app made from the template and one that added the block behave differently,
// and `shadcn add` would offer to overwrite the template's copy.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const root = new URL("../../", import.meta.url)

/** [block file, the template's copy of it] */
const COPIES: readonly (readonly [string, string])[] = [
  ["registry/blocks/api-fetch/lib/api-fetch.ts", "templates/full-app/src/lib/api-fetch.ts"],
  [
    "registry/blocks/api-fetch/components/session-expired-banner.tsx",
    "templates/full-app/src/components/session-expired-banner.tsx",
  ],
  [
    "registry/blocks/api-fetch/test/ui/api-fetch.test.tsx",
    "templates/full-app/test/ui/api-fetch.test.tsx",
  ],
]

describe("block files the template also ships", () => {
  for (const [block, template] of COPIES) {
    it(`${template} matches ${block}`, () => {
      assert.equal(
        readFileSync(new URL(template, root), "utf8"),
        readFileSync(new URL(block, root), "utf8"),
        `copy ${block} over ${template} (or the other way) so they match`
      )
    })
  }
})
