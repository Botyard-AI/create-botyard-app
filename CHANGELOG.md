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

## [@botyard/runtime@0.1.0] - 2026-11-16

### Added

- `call(tool, args?, opts?)`: call a Botyard tool by its canonical name. The
  name is looked up in the bot's live tool list; no org or server prefix is
  hardcoded.
- Automatic transport selection: the native `botyardd` daemon when its socket
  exists, else the OpenClaw bridge's loopback MCP proxy (`MCP_PROXY_PORT`).
  Override it with `BOTYARD_RUNTIME_TRANSPORT` or `createRuntime({ transport })`.
- A mock transport for tests and local development, with JSON fixture files
  (`BOTYARD_RUNTIME_MOCK_FIXTURES`) and call recording.
- Typed errors: `InvalidInputError`, `UnknownToolError`, `ToolError`,
  `OutcomeUnknownError` and `TransportError`, all extending `BotyardError`.
  Nothing is retried, least of all an unknown outcome.
- `getIdentity()`: the bot, its org and the transport in use.
- The `ToolCaller` interface, for code that accepts a caller.

## [@botyard/runtime@0.0.1-alpha.0] - 2026-11-16

### Added

- Placeholder module that throws a "not ready yet" error on import. It has no
  API; this prerelease exists to validate trusted publishing for this package.

## [@botyard/botpage@0.0.1-alpha.0] - 2026-11-16

### Added

- Placeholder module that throws a "not ready yet" error on import. It has no
  API; this prerelease exists to validate trusted publishing for this package.

## [@botyard/ui@0.0.1-alpha.0] - 2026-11-16

### Added

- Placeholder module that throws a "not ready yet" error on import. It has no
  API; this prerelease exists to validate trusted publishing for this package.

## [create-botyard-app@0.0.1-alpha.0] - 2026-11-16

### Added

- Placeholder CLI that prints a "not ready yet" notice and exits non-zero. It
  scaffolds nothing; this prerelease exists to validate the release pipeline
  (trusted publishing, provenance and the GitHub release) end to end.
