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
- Tooling: the Botyard monorepo's TypeScript standard. ESLint 9 with the shared
  config in `tooling/eslint-config` and a type-aware zero-`any` layer, Prettier,
  Vitest 4, knip, TypeScript 5.9.3 and a shared `tsconfig.base.json`. CI runs
  lint, format check, typecheck, test, build and knip.
- Release checks: every published package's README must be in its tarball.
  Rendered as Markdown, it must start with the pinned Botyard header image,
  use only absolute https links and images, pin images from this repository
  to a commit, and avoid `<picture>`, which npm strips. `pnpm run lint` and
  the release workflow run them.
- GitHub releases get a branded header and footer around the changelog
  section, with install, provenance and docs links.

### Changed

- `create-botyard-app`: the next steps it prints install with
  `npm ci --include=dev`, so the test and build tools are installed even where
  `NODE_ENV=production`, as inside a Botyard bot. They also show how to run the
  app on your machine (`npm run dev:mock`) and inside a bot (`npm run dev`,
  then `npm run expose` from a second shell).
- `create-botyard-app`: branded README on npm, with the Botyard logo, badges,
  and links to the source, changelog and Botyard docs.
- `@botyard/runtime`: branded README on npm, with the Botyard logo, badges,
  and links to the source, changelog and Botyard docs.
- `@botyard/botpage`: branded README on npm, with the Botyard logo, badges,
  and links to the source, changelog and Botyard docs.
- `create-botyard-app`: the quick start in this README and in the generated
  app's README installs with `npm ci --include=dev`, so the test and build
  tools are installed even where `NODE_ENV=production`, as inside a bot. It
  also runs `dev` and `expose` in separate shells, and the generated app's
  README gets a Troubleshooting section.
- `@botyard/runtime`: the README documents `defaultRuntime()`.
- `@botyard/botpage`: the README no longer says deep links are unusable.
  `list_navigation_destinations` now returns route templates, so
  `deeplinks.resolve()` builds links.
- `@botyard/botpage`: exported object types are declared with `type` instead
  of `interface`, as the Botyard TypeScript standard requires. Nothing changes
  at runtime, and the emitted JavaScript is the same. For TypeScript users,
  these types can no longer be extended through declaration merging.

## [create-botyard-app@0.1.0] - 2026-11-17

### Added

- The real CLI, replacing the placeholder.
  `create-botyard-app <directory> [--template <name>] [--name <name>]` copies
  a template bundled in the package into a new or empty directory, then names
  the app in its `package.json` and `botyard.json`. It downloads nothing,
  installs nothing, and never overwrites or deletes anything; if it fails
  part-way it leaves what it created and lists the paths it created, as a
  record to check rather than a list to delete. The build bundles the
  repository's `templates/` into the package.
- The `full-app` template, the default. A Node API on
  `@botyard/runtime` and `@botyard/botpage`, listening on `127.0.0.1` only,
  and a Vite, React 19, Tailwind CSS v4 and shadcn/ui front end with a badge
  for the signed-in viewer. `botyard.json` names the Bot Page and its port;
  `npm run expose` publishes it. Tests run against the mock runtime, and
  `npm run dev:mock` runs it outside a bot. Every dependency is pinned to an
  exact version in a committed, integrity-checked `package-lock.json`, and
  install scripts are off. The CLI build pins the template's
  `@botyard/*` dependencies to their published `latest` versions.

## [@botyard/runtime@0.1.1] - 2026-11-16

### Changed

- Exported object types are declared with `type` instead of `interface`, as
  the Botyard TypeScript standard requires. Nothing changes at runtime, and
  the emitted JavaScript is the same. For TypeScript users, these types can no
  longer be extended through declaration merging.

### Fixed

- `call()` now rejects `args` whose `toJSON()` does not produce a JSON object
  with `InvalidInputError`, before anything is sent. Before, the non-object
  value was sent as the tool's arguments.
- `loadMockFixtures()` (and `BOTYARD_RUNTIME_MOCK_FIXTURES`) now validates the
  whole file and throws `TransportError` naming the problem, such as an
  unknown `error.kind` or a non-string `error.message`. Before, a malformed
  fixture loaded and failed later at call time, with an unrelated error.

## [@botyard/botpage@0.1.0] - 2026-11-16

### Added

- `createBotPage({ tools })`: viewer identity, guards and deeplinks for apps
  served as Botyard Bot Pages. `tools` is any `ToolCaller`, such as the
  `@botyard/runtime` client.
- `viewer(req)` reads only `x-forwarded-user`, the one identity header the
  Bot Page proxy sets, and enriches the viewer through `list_org_members`
  with a per-process TTL cache. Failed refreshes back off, and a stale list
  authorizes for at most `maxStaleMs` past its TTL before guards fail closed.
  `avatarUrl` is `null` until the platform returns avatars.
- Pluggable `IdentitySource`, with a closed set of failure reasons, ready for
  signed viewer assertions. The header strategy is `trustedForwardedUser()`.
- Bot viewers: a bot's shadow address (`bot+<id>@bots.botyard.internal`)
  resolves to `{ kind: "bot", botId }` with no email and no directory lookup.
- `requireMember(req, { roles })` guard: 401, 403, or 503 from the adapters
  when the directory is unavailable.
- Dev viewer override (`devViewer` / `BOTYARD_DEV_VIEWER`), refused when
  `NODE_ENV=production` and ignored unless the server listens on loopback.
- Loopback guards: `listenLoopback()` refuses non-loopback hosts;
  `guardListen()` and `bind` warn on wider binds.
- `deeplinks.resolve(key, params)` resolves Botyard app links through
  `list_navigation_destinations`, from each destination's `path` and `search`
  (a list of `{ name, value }`) templates. It throws `DeeplinkUnavailableError`
  until that tool returns them.
- Adapters: `@botyard/botpage/node`, `@botyard/botpage/hono` (optional peer
  `hono`) and `@botyard/botpage/next`.

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
