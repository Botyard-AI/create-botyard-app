// Regression cases for readme-rules.mjs. Run with `node --test scripts/release/readme-rules.test.mjs` (part of `pnpm test`).
import assert from "node:assert/strict"
import { test } from "node:test"

import { readmeProblems } from "./readme-rules.mjs"

const SHA = "f52b7e38493a4218d32789d0d08060c47edee504"
const ICON = `https://raw.githubusercontent.com/Botyard-AI/create-botyard-app/${SHA}/assets/brand/botyard-app-icon-navy.svg`
const HEADER = `<p align="center">\n  <a href="https://botyard.io"><img src="${ICON}" alt="Botyard" width="96"></a>\n</p>\n\n`
const BADGES = `<p align="center">\n  <a href="https://www.npmjs.com/package/x"><img src="https://img.shields.io/npm/v/x" alt="npm"></a>\n</p>\n`
const valid = (body = "") =>
  `${HEADER}# x\n\nText with [a link](https://botyard.io).\n\n${BADGES}${body}`

const fails = (readme, pattern) => {
  const problems = readmeProblems(readme)
  assert.ok(
    problems.some((p) => pattern.test(p)),
    `expected a problem matching ${pattern}, got ${JSON.stringify(problems)}`
  )
}

test("a valid README passes", () => {
  assert.deepEqual(readmeProblems(valid()), [])
})

test("code is not checked: examples may show relative paths", () => {
  const body = '\n```md\n![x](./x.png) <img src="./y.png">\n```\n\nInline `[x](./z)` too.\n'
  assert.deepEqual(readmeProblems(valid(body)), [])
})

test("an in-page anchor link is fine", () => {
  assert.deepEqual(readmeProblems(valid("\nSee [below](#errors).\n")), [])
})

test("the header icon is required even when badges remain", () => {
  fails(`# x\n\n${BADGES}`, /header image before its heading/)
})

test("the header icon must come before the heading", () => {
  fails(`# x\n\n${HEADER}`, /header image before its heading/)
})

test("the header icon must be pinned", () => {
  fails(valid().replace(SHA, "main"), /not pinned to a commit SHA/)
})

test("a missing heading fails", () => {
  fails(HEADER, /no `# ` heading/)
})

test("relative inline image", () => {
  fails(
    valid("\n![logo](assets/logo.svg)\n"),
    /image is not an absolute https URL: assets\/logo.svg/
  )
})

test("relative reference-style image", () => {
  fails(
    valid("\n![Diagram][diagram]\n\n[diagram]: ./diagram.svg\n"),
    /reference .*\.\/diagram\.svg/
  )
})

test("relative reference-style link with angle brackets", () => {
  fails(valid("\n[Docs][d]\n\n[d]: <./docs.md>\n"), /reference .*\.\/docs\.md/)
})

test("single-quoted relative <img>", () => {
  fails(valid("\n<img src='./logo.svg'>\n"), /image is not an absolute https URL: \.\/logo\.svg/)
})

test("unquoted relative <img>", () => {
  fails(valid("\n<img src=logo.svg alt=x>\n"), /image is not an absolute https URL: logo\.svg/)
})

test("<img> whose src cannot be read", () => {
  fails(valid("\n<img alt='no source'>\n"), /without a readable src/)
})

test("<img srcset>", () => {
  fails(valid('\n<img src="https://a/x.png" srcset="./x2.png 2x">\n'), /srcset/)
})

test("badge inside a link with a relative outer destination", () => {
  fails(valid("\n[![b](https://img.shields.io/x)](./CHANGELOG.md)\n"), /link .*\.\/CHANGELOG\.md/)
})

test("relative <a href>", () => {
  fails(valid("\n<a href='docs/x.md'>x</a>\n"), /link is not an absolute https URL: docs\/x\.md/)
})

test("relative inline link", () => {
  fails(valid("\nSee [docs](./docs.md).\n"), /link is not an absolute https URL: \.\/docs\.md/)
})

test("http image", () => {
  fails(valid('\n<img src="http://a/c.svg">\n'), /not an absolute https URL: http:/)
})

test("unpinned image from this repository", () => {
  const url = "https://raw.githubusercontent.com/Botyard-AI/create-botyard-app/main/x.svg"
  fails(valid(`\n![x](${url})\n`), /not pinned to a commit SHA/)
})

test("<picture> is rejected", () => {
  fails(valid('\n<picture><source srcset="https://a/b.svg"></picture>\n'), /<picture>/)
})
