# AGENTS.md

Guidance for AI agents (and humans) changing this repository.

- Read `CONTRIBUTING.md` first. Every change goes through a PR to `main`.
- Never weaken security posture to get a change through: do not unpin actions,
  widen `permissions:`, add `pull_request_target`, or add dependencies with
  install scripts. Changing `.github/` or `scripts/` needs a code owner anyway.
- Actions are pinned by `.github/workflows/actions.lock`, GitHub's workflow
  dependency lockfile, which records the commit of every action the workflows
  run, including actions that other actions call. Reference actions by an exact
  release tag (`owner/repo@vX.Y.Z`, never `@v4` or `@main`), run
  `gh actions-lock` after any `uses:` change, and commit the workflow and the
  lockfile together. Never edit the lockfile by hand. Add new actions to the
  allow-list in `scripts/apply-repo-settings.sh`.
- The required status checks are the job ids `ci`, `zizmor` and `actions-lock`.
  If you rename a job, update `.github/rulesets/main.json` in the same PR.
- Templates must never contain secrets, real customer data, or hardcoded org,
  bot or tool-prefix identifiers.
- Code must pass the zero-`any` lint layer (`tooling/eslint-config/zero-any.js`).
  Narrow `unknown` at real boundaries instead of casting. Never add a blanket or
  file-wide disable; a line disable needs the reason on the line above it.
- `tooling/eslint-config/{base,node,react}.js` are verbatim copies of the
  monorepo's config. Change them only by re-syncing (see its README).
