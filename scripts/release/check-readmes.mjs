#!/usr/bin/env node
// Checks the README that each publishable package ships to npm.
//
//   node scripts/release/check-readmes.mjs                  # every packages/* that is not private
//   node scripts/release/check-readmes.mjs packages/runtime # just these
//
// npm shows the README packed into the published version, so
// `pnpm pack --dry-run` (what release.yml packs) must include README.md, and
// the README must meet the rules in readme-rules.mjs.
// Run by `pnpm run lint` in CI and by scripts/release/prepare.mjs.

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { readmeProblems } from "./readme-rules.mjs"

const publishable = () =>
  readdirSync("packages", { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join("packages", d.name))
    .filter((dir) => {
      const file = join(dir, "package.json")
      return existsSync(file) && !JSON.parse(readFileSync(file, "utf8")).private
    })

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
