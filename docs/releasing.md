# Releasing

Packages are published to npm by `.github/workflows/release.yml` through
[trusted publishing](https://docs.npmjs.com/trusted-publishers): GitHub Actions
proves its identity to npm with OIDC, so no npm token exists anywhere. Every
version carries a provenance statement linking it to the commit and workflow
run that built it.

Each package is versioned and released on its own. Only these four can be
released: `create-botyard-app`, `@botyard/runtime`, `@botyard/botpage` and
`@botyard/ui`. `botyard` and `create-botyard` are placeholders that are never
published.

## Release a package

1. In a PR, bump `version` in `packages/<dir>/package.json` and rename the
   package's lines under `## [Unreleased]` in `CHANGELOG.md` to a section
   headed exactly:

   ```md
   ## [<name>@<version>] - YYYY-MM-DD
   ```

   For example `## [@botyard/runtime@0.2.0] - 2026-11-20`. Merge the PR.
2. **Actions → Release → Run workflow** on `main`, and pick the package.
3. A member of the release team approves the `npm-publish` deployment. You
   cannot approve your own run.

The workflow then:

| Job | Permissions | Does |
| --- | --- | --- |
| `prepare` | `contents: read` | Checks the release (below), runs lint, typecheck, test and build for the package and its workspace dependencies, then packs the tarball with `pnpm pack`. |
| `publish` | `id-token: write`, in `npm-publish` | `npm publish <tarball> --provenance` with dist-tag `latest`, or `next` for a prerelease such as `1.0.0-rc.1`. |
| `github-release` | `contents: write` | Creates tag `<name>@<version>` on the released commit and a GitHub release with the changelog section as notes and the tarball attached. |

`prepare` refuses to continue when:

- the run is not on `main`;
- the package is private or its `repository.url` is not this repository (npm
  would reject the provenance);
- the version is not `x.y.z` or `x.y.z-pre`;
- `CHANGELOG.md` has no non-empty section for `<name>@<version>`;
- a stable version is not greater than the current `latest` on npm;
- the version is already on npm, unless it was published by this workflow from
  this exact commit, as shown by its provenance.

## When a release fails

Use **Re-run all jobs** on the failed run. It runs from the same commit, so
`prepare` sees a version this run already published, skips `publish`, and
finishes the tag and GitHub release. A published version is never overwritten.
Fix anything else in a PR and release a new version.

## npm settings

Each of the four packages on npmjs.com has:

- **Trusted Publisher → GitHub Actions**: repository
  `Botyard-AI/create-botyard-app`, workflow `release.yml`, environment
  `npm-publish`.
- **Allowed actions**: `npm publish` allowed; `npm dist-tag` not allowed. The
  workflow sets the dist-tag when it publishes, so CI never needs to move tags
  on existing versions. Move one by hand, with 2FA, if you ever must.
- **Publishing access**: require two-factor authentication and disallow tokens.

`botyard` and `create-botyard` have no trusted publisher, only the 2FA and
no-tokens setting.

The `publish` job runs on Node 24.22.3 because trusted publishing needs npm
11.5.1 or later and Node 22 ships npm 10. It only publishes a tarball that was
built and tested on the `.nvmrc` Node version.
