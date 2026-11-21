# Repository settings

Settings live in the repository so they can be reviewed and re-applied:

- `.github/rulesets/*.json`: branch and tag rulesets (GitHub REST format; also
  importable in the UI under **Settings → Rules → Rulesets → New ruleset → Import**).
- `scripts/apply-repo-settings.sh`: everything else, applied with `gh api`.

An org admin runs `scripts/apply-repo-settings.sh` once after bootstrap and again
after any PR that changes these files.

## What is enforced

| Area | Setting | Why |
| --- | --- | --- |
| `main` | PR required, 1 code-owner approval of the latest push, stale approvals dismissed, threads resolved | Nothing reaches `main`, and so npm, unreviewed |
| `main` | Required checks `ci` and `zizmor`, branch up to date | Tested, and workflows linted |
| `main` | Squash only, linear history, signed commits, no force-push or deletion | Each published change maps to one reviewed, GitHub-signed commit |
| `main` | Org admins may bypass, **only through a PR** | Break-glass for a solo maintainer, visible in the audit log; no direct pushes |
| Tags `v*`, `*@*` | No deletion, update or force-push | A released tag can never be moved |
| Releases | Immutable releases | Published release assets cannot be swapped |
| Actions | Allow-listed actions only, full-SHA pinning required, read-only `GITHUB_TOKEN`, Actions cannot approve PRs | Supply chain and token blast radius |
| Actions | Approval required for every outside contributor's workflow run | Outside code never runs unattended |
| Security | Secret scanning + push protection, Dependabot alerts + security updates, private vulnerability reporting, CodeQL | Standard for a public package |
| Environment `npm-publish` | `main` only, team approval, no self-review | Human sign-off on every release |
| Environment `blocks-publish` | `main` only, team approval, no self-review | Human sign-off on every publish of `blocks.botyard.io` ([blocks.md](./blocks.md)) |

## Manual steps (not scriptable)

1. **npm org.** Create the `botyard` organisation on npmjs.com, require 2FA for all
   members, and add maintainers only.
2. **Reserve names.** With 2FA, publish a `0.0.0` placeholder of `create-botyard-app`,
   `@botyard/runtime`, `@botyard/botpage`, `@botyard/ui`, and also `botyard` and
   `create-botyard` (defensive). A trusted publisher can only be configured on a
   package that exists.
3. **Trusted publishing.** For each package on npmjs.com: **Settings → Trusted
   Publisher → GitHub Actions**, repository `Botyard-AI/create-botyard-app`,
   workflow `release.yml`, environment `npm-publish`. Under **Allowed actions**
   tick **Allow `npm publish`** and leave **Allow `npm dist-tag`** unticked. Then
   set **Publishing access → Require two-factor authentication and disallow
   tokens**. `botyard` and `create-botyard` get no trusted publisher, only the
   2FA and no-tokens setting. See [releasing.md](./releasing.md).
   No `NPM_TOKEN` secret is ever created.
4. **Pull request access.** If the org has GitHub's option to limit who can open
   pull requests, set it to collaborators only. Otherwise external PRs are
   closed by hand, per `CONTRIBUTING.md`.
5. **Blocks registry.** In the `blocks-publish` environment, add the secret
   `CLOUDFLARE_API_TOKEN` (the deploy token for the `botyard-blocks` Worker,
   from the Botyard monorepo's `infra/blocks-registry`) and the variable
   `CLOUDFLARE_ACCOUNT_ID`. Never as repository secrets. See [blocks.md](./blocks.md).
6. **Org policy (recommended).** Require 2FA for the GitHub org, and require
   actions to be pinned to full SHAs across the org.
