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
- Third-party actions are pinned to full commit SHAs and must be on the
  allow-list in `scripts/apply-repo-settings.sh`.
- Repository settings are code: change `.github/rulesets/` or
  `scripts/apply-repo-settings.sh` in a PR, then an org admin re-runs the script.
