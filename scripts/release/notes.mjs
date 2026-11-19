// Wraps a package's CHANGELOG section in the branded GitHub release body.
// Used by scripts/release/prepare.mjs; github-release publishes the result
// as-is. Every link is pinned to the released commit, so a release page never
// changes after the fact.

const REPO = "https://github.com/Botyard-AI/create-botyard-app"
const RAW = "https://raw.githubusercontent.com/Botyard-AI/create-botyard-app"

/**
 * @param {{ name: string, version: string, dir: string, sha: string, notes: string }} release
 * @returns {string} Markdown for the GitHub release body.
 */
export function releaseNotes({ name, version, dir, sha, notes }) {
  const brand = `${RAW}/${sha}/assets/brand`
  const install =
    name === "create-botyard-app"
      ? `npx create-botyard-app@${version} my-app`
      : `npm install ${name}@${version}`
  return `<p>
  <a href="https://botyard.io">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="${brand}/botyard-lockup-on-dark.svg">
      <img src="${brand}/botyard-lockup-on-light.svg" alt="Botyard" width="181">
    </picture>
  </a>
</p>

## ${name} ${version}

${notes.trim()}

---

\`\`\`sh
${install}
\`\`\`

Built and published by [the release workflow](${REPO}/blob/${sha}/.github/workflows/release.yml) from [\`${sha.slice(0, 7)}\`](${REPO}/commit/${sha}), with [npm provenance](https://docs.npmjs.com/generating-provenance-statements): after installing, \`npm audit signatures\` verifies it.

[README](${REPO}/tree/${sha}/${dir}#readme) · [npm](https://www.npmjs.com/package/${name}/v/${version}) · [Changelog](${REPO}/blob/${sha}/CHANGELOG.md) · [Bot Pages docs](https://docs.botyard.io/docs/hosting-apps) · [botyard.io](https://botyard.io)
`
}
