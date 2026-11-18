# Contributing

`create-botyard-app` is open source so you can read, audit and use it. It is
developed by the Botyard-AI team.

## What we welcome

- **Bug reports and feature requests** as [issues](https://github.com/Botyard-AI/create-botyard-app/issues).
- **Questions and ideas** in [discussions](https://github.com/Botyard-AI/create-botyard-app/discussions).
- **Security reports**, privately; see [SECURITY.md](./SECURITY.md). Never in a public issue.

## Pull requests

We do not accept pull requests from outside the Botyard-AI team. This keeps every
line we publish to npm written and reviewed by people accountable for it. If you
have a fix, open an issue describing it; we are glad to credit you in the
changelog when we land it.

## For maintainers

- Branch from `main`; open a PR. `main` accepts squash merges only, after CI
  (`ci`, `zizmor`) passes and a code owner approves the latest push.
- User-visible changes add a line under `## [Unreleased]` in `CHANGELOG.md`.
- Before pushing, run the checks CI runs: `pnpm run lint`, `pnpm run format:check`
  (`pnpm run format` fixes it), `pnpm run typecheck`, `pnpm test`, `pnpm run build`
  and `pnpm run knip`. The tooling follows the Botyard monorepo's TypeScript
  standard; see `tooling/eslint-config/README.md`.
- Template dependencies are exact pins with a committed `package-lock.json`.
  After changing a template's dependencies, run
  `scripts/lock-template.sh <template>`: it resolves third-party versions as
  of 3 days ago and runs no install scripts.
- Templates use our own packages (`@botyard/runtime`, `@botyard/botpage`) as
  `workspace:*`, so tests run against the sources here. The CLI build pins them
  to the versions in `packages/*/package.json`, and fails unless each is the
  current `latest` on npm and locked as published, so release an SDK package
  before a template that needs it. The build needs the npm registry.
- `examples/` holds standalone apps scaffolded with the published
  `create-botyard-app` and built on our packages **as published on npm**:
  exact versions in `dependencies`, never `workspace:*`, with their own
  `package-lock.json`. They are outside the pnpm workspace; the root lint,
  format and knip skip them, and `scripts/check-examples.sh` (run by CI)
  installs each one with `npm ci` and runs its own checks. After changing an
  example's dependencies, run `scripts/lock-template.sh examples/<name>`.
- Actions are referenced by exact release tag and pinned to commits by
  `.github/workflows/actions.lock`, including the actions they call in turn.
  After adding, removing or changing any `uses:`, run `gh actions-lock` (install
  once with `gh extension install github/gh-actions-lock`) and commit the
  lockfile with the workflow. The `actions-lock` check fails on a missing or
  stale lockfile. New actions must also be on the allow-list in
  `scripts/apply-repo-settings.sh`. See `docs/releasing.md`.
- Repository settings are code: change `.github/rulesets/` or
  `scripts/apply-repo-settings.sh` in a PR, then an org admin re-runs the script.
