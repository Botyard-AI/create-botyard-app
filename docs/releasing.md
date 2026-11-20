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
2. **Actions → Release → Run workflow** on `main`, and pick the package. The
   run is named `Release <name>`, for example `Release @botyard/runtime`, and
   its summary shows the exact `<name>@<version>` that `prepare` resolved.
3. A member of the release team approves the `npm-publish` deployment. You
   cannot approve your own run. Check that the run name and summary show the
   package and version you expect before approving.

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

## Releasing a package the template uses

`create-botyard-app` bundles `templates/full-app`, which depends on
`@botyard/runtime` and `@botyard/botpage`. The CLI build pins those
dependencies to the versions in `packages/*/package.json` and requires each
one to be npm's `latest` and locked by integrity in
`templates/full-app/package-lock.json`. Two consequences:

- **Before the library is published**, its release PR bumps the version ahead
  of npm. CI sets `BOTYARD_ALLOW_UNPUBLISHED_BUMP=1` on its `test` and `build`
  steps, which accepts a stable version strictly ahead of npm's `latest`
  without the lockfile check for that package. Everything else is still fully
  checked, and local builds and `release.yml` never set the variable.
- **Once the library is published**, its version equals npm's `latest`, so
  the full check applies again, in CI too. The template lockfile still locks
  the previous version, so **`ci` fails on `main` and on every PR** until the
  lockfile is regenerated. This is the cost of keeping the "equal to npm"
  check strict.

So after publishing `@botyard/runtime` or `@botyard/botpage`, regenerate the
template lockfile before anything else merges:

```sh
scripts/lock-template.sh full-app
```

The `create-botyard-app` release owns this step. When several libraries are
released together, publish them first, then open the `create-botyard-app`
release PR straight away with the regenerated lockfile, so `ci` is red for as
short a time as possible. Say so in status updates while `main` is red.
`lock-template.sh` locks our packages at their workspace versions, so it
cannot run while a bumped package is still unpublished.

## When a release fails

Use **Re-run all jobs** on the failed run. It runs from the same commit, so
`prepare` sees a version this run already published, skips `publish`, and
finishes the tag and GitHub release. A published version is never overwritten.
Fix anything else in a PR and release a new version.

## Actions lockfile

`.github/workflows/actions.lock` is GitHub's
[workflow dependency lockfile](https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles).
It records the exact commit, and the owning repository's numeric id, of every
action the workflows run, including actions that a composite action calls
(for example the `github/codeql-action` that `zizmor-action` uses). Every
workflow is onboarded, so GitHub runs the locked commit even if a tag moves,
and refuses to start a job whose actions are not in the lockfile. This matters
most for `release.yml`, whose `publish` job holds the npm OIDC permission.

- Workflows reference actions by exact release tag, such as
  `actions/checkout@v7.0.1`. The lockfile, not the `uses:` line, holds the
  commit.
- After adding, removing or changing a `uses:`, run `gh actions-lock` from the
  repository root (`gh extension install github/gh-actions-lock` once), review
  the diff, and commit the workflow and lockfile together. Never edit the
  lockfile by hand, and never delete it to clear an error: restore it from
  `main` and run `gh actions-lock` again.
- Dependabot's `github-actions` updates regenerate the matching lockfile entry
  in the same PR. No extra configuration is needed.
- The `actions-lock` check runs `gh actions-lock --verify`. It fails when the
  lockfile is missing, does not match the workflows, or a locked commit no
  longer verifies upstream: a moved release tag, rewritten history, or a
  repository replaced under the same name. Investigate before accepting any
  of these. Never run `--accept-moved` in automation.
- The lockfile does not pin container images, tools that actions download (the
  Node and pnpm versions are set explicitly in the workflows), or the zizmor
  version that `zizmor-action` installs.

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
