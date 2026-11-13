# AGENTS.md

Guidance for AI agents (and humans) changing this repository.

- Read `CONTRIBUTING.md` first. Every change goes through a PR to `main`.
- Never weaken security posture to get a change through: do not unpin actions,
  widen `permissions:`, add `pull_request_target`, or add dependencies with
  install scripts. Changing `.github/` or `scripts/` needs a code owner anyway.
- Pin every third-party action to a full commit SHA with a `# vX.Y.Z` comment,
  and add new actions to the allow-list in `scripts/apply-repo-settings.sh`.
- The required status checks are the job ids `ci` and `zizmor`. If you rename a
  job, update `.github/rulesets/main.json` in the same PR.
- Templates must never contain secrets, real customer data, or hardcoded org,
  bot or tool-prefix identifiers.
