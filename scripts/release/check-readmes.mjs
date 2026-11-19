#!/usr/bin/env node
// Checks the README that each publishable package ships to npm.
//
//   node scripts/release/check-readmes.mjs                  # every packages/* that is not private
//   node scripts/release/check-readmes.mjs packages/runtime # just these
//
// npm shows the README packed into the published version, and renders it
// away from this repository, so:
// - `pnpm pack --dry-run` (what release.yml packs) must include README.md;
// - every image and link must be an absolute https URL: npm cannot resolve a
//   relative path, and an image from this repository must be pinned to a
//   commit so a later change cannot alter a published README;
// - no <picture>/<source>: npm strips them, leaving no logo.
// Run by `pnpm run lint` in CI and by scripts/release/prepare.mjs.

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const RAW_PREFIX = "https://raw.githubusercontent.com/Botyard-AI/create-botyard-app/"
const PINNED_RAW =
  /^https:\/\/raw\.githubusercontent\.com\/Botyard-AI\/create-botyard-app\/[0-9a-f]{40}\//

const publishable = () =>
  readdirSync("packages", { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join("packages", d.name))
    .filter((dir) => {
      const file = join(dir, "package.json")
      return existsSync(file) && !JSON.parse(readFileSync(file, "utf8")).private
    })

/** Problems with one README's text. */
function readmeProblems(text) {
  const problems = []
  // Code blocks and code spans are examples, not rendered links.
  const prose = text
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "")
  if (/<(picture|source)\b/i.test(prose)) problems.push("uses <picture>/<source>, which npm strips")
  const images = [
    ...[...prose.matchAll(/<img\b[^>]*?\bsrc="([^"]*)"/gi)].map((m) => m[1]),
    ...[...prose.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g)].map((m) => m[1]),
  ]
  const links = [
    ...[...prose.matchAll(/<a\b[^>]*?\bhref="([^"]*)"/gi)].map((m) => m[1]),
    ...[...prose.matchAll(/(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+)/g)].map((m) => m[1]),
  ]
  for (const url of images) {
    if (!url.startsWith("https://")) problems.push(`image is not an absolute https URL: ${url}`)
    else if (url.startsWith(RAW_PREFIX) && !PINNED_RAW.test(url))
      problems.push(`image from this repository is not pinned to a commit SHA: ${url}`)
  }
  for (const url of links) {
    if (!url.startsWith("https://") && !url.startsWith("#"))
      problems.push(`link is not an absolute https URL: ${url}`)
  }
  if (images.length === 0) problems.push("has no header logo")
  return problems
}

const dirs = process.argv.length > 2 ? process.argv.slice(2) : publishable()
let failures = 0
for (const dir of dirs) {
  const name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name
  const report = (problem) => {
    console.error(`::error file=${dir}/README.md::${name}: ${problem}`)
    failures += 1
  }
  const packed = JSON.parse(
    execFileSync("pnpm", ["pack", "--dry-run", "--json"], { cwd: dir, encoding: "utf8" })
  )
  if (!packed.files.some((file) => file.path === "README.md")) {
    report("README.md is not in the packed tarball")
    continue
  }
  readmeProblems(readFileSync(join(dir, "README.md"), "utf8")).forEach(report)
}
if (failures > 0) process.exit(1)
console.log(`README checks passed: ${dirs.join(", ")}`)
