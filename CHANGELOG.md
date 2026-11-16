# Changelog

All notable changes to the packages in this repository are recorded here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Versions follow
[Semantic Versioning](https://semver.org/).

Packages are released separately. A release section is headed
`## [<name>@<version>] - YYYY-MM-DD`; see [docs/releasing.md](docs/releasing.md).

## [Unreleased]

### Added

- Repository bootstrap: CI, workflow linting, OpenSSF Scorecard, Dependabot,
  rulesets and repository settings as code.
- Release workflow: per-package npm publishing through trusted publishing with
  provenance, gated by the `npm-publish` environment. See `docs/releasing.md`.
