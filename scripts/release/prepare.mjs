#!/usr/bin/env node
// Resolves and checks a release before anything is built or published.
// Runs in the read-only `prepare` job of .github/workflows/release.yml.
//
// Inputs (environment): PACKAGE (npm name), GITHUB_SHA, GITHUB_OUTPUT,
// RUNNER_TEMP. Writes outputs: dir, version, tag, dist_tag, published.
// Fails, before any side effect, when the release is not safe to make.

import { appendFileSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const REPO_URL = "git+https://github.com/Botyard-AI/create-botyard-app.git"
const REGISTRY = "https://registry.npmjs.org"

const fail = (message) => {
  console.error(`::error::${message}`)
  process.exit(1)
}

const env = (name) => process.env[name] || fail(`missing environment variable ${name}`)

const name = env("PACKAGE")
const sha = env("GITHUB_SHA")

// 1. Find the workspace package. Only packages/* can be released; templates are
//    shipped inside create-botyard-app, never published on their own.
const dirs = existsSync("packages")
  ? readdirSync("packages", { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join("packages", d.name))
  : []
const matches = dirs.filter((dir) => {
  const file = join(dir, "package.json")
  return existsSync(file) && JSON.parse(readFileSync(file, "utf8")).name === name
})
if (matches.length !== 1)
  fail(`expected exactly one packages/*/package.json named ${name}, found ${matches.length}`)
const dir = matches[0]
const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))

if (manifest.private) fail(`${name} is private`)
// npm rejects a provenance statement whose repository does not match the
// workflow's repository, so catch it here rather than at publish time.
if (manifest.repository?.url !== REPO_URL) fail(`${name}: repository.url must be ${REPO_URL}`)

const version = manifest.version
const semver = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version ?? "")
if (!semver) fail(`${name}: version ${JSON.stringify(version)} is not x.y.z or x.y.z-pre`)
const prerelease = semver[4] !== undefined
const distTag = prerelease ? "next" : "latest"
const tag = `${name}@${version}`

// 2. CHANGELOG.md is the only source of release notes.
const changelog = readFileSync("CHANGELOG.md", "utf8").split("\n")
const heading = `## [${tag}]`
const start = changelog.findIndex((line) => line === heading || line.startsWith(`${heading} `))
if (start === -1) fail(`CHANGELOG.md has no "${heading} - YYYY-MM-DD" section`)
let end = changelog.findIndex((line, i) => i > start && line.startsWith("## "))
if (end === -1) end = changelog.length
const notes = changelog
  .slice(start + 1, end)
  .join("\n")
  .trim()
if (!notes) fail(`CHANGELOG.md section "${heading}" is empty`)
writeFileSync(join(env("RUNNER_TEMP"), "release-notes.md"), `${notes}\n`)

// 3. Compare with what is already on npm.
const res = await fetch(`${REGISTRY}/${name.replace("/", "%2F")}`, {
  headers: { accept: "application/json" },
})
if (res.status !== 200 && res.status !== 404)
  fail(`npm registry returned ${res.status} for ${name}`)
const packument = res.status === 200 ? await res.json() : { versions: {}, "dist-tags": {} }

let published = false
if (packument.versions?.[version]) {
  // Resume only the release that published this exact commit; otherwise the
  // tag and GitHub release would point at code that was never published.
  const url = packument.versions[version].dist?.attestations?.url
  if (!url) fail(`${tag} is already on npm without provenance; bump the version`)
  const att = await fetch(url)
  if (att.status !== 200) fail(`could not read provenance for ${tag} (${att.status})`)
  const builds = (await att.json()).attestations
    .filter((a) => a.predicateType?.startsWith("https://slsa.dev/provenance/"))
    .map(
      (a) =>
        JSON.parse(Buffer.from(a.bundle.dsseEnvelope.payload, "base64").toString("utf8")).predicate
          ?.buildDefinition
    )
    .filter(Boolean)
  const ours = builds.some(
    (b) =>
      b.externalParameters?.workflow?.repository ===
        "https://github.com/Botyard-AI/create-botyard-app" &&
      b.externalParameters?.workflow?.path === ".github/workflows/release.yml" &&
      b.resolvedDependencies?.some((dep) => dep.digest?.gitCommit === sha)
  )
  if (!ours) fail(`${tag} is already on npm, but not from release.yml at ${sha}; bump the version`)
  published = true
  console.log(`${tag} is already published from ${sha}; resuming the remaining steps.`)
} else if (!prerelease) {
  // Never move `latest` backwards.
  const latest = packument["dist-tags"]?.latest
  const parts = (v) => v.split("-")[0].split(".").map(Number)
  if (latest && !/-/.test(latest)) {
    const [a, b] = [parts(version), parts(latest)]
    const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
    if (cmp <= 0) fail(`${version} is not greater than the current latest ${latest}`)
  }
}

const outputs = { dir, version, tag, dist_tag: distTag, published: String(published) }
appendFileSync(
  env("GITHUB_OUTPUT"),
  Object.entries(outputs)
    .map(([k, v]) => `${k}=${v}\n`)
    .join("")
)
console.log(outputs)
