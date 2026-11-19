#!/usr/bin/env bash
# Apply the repository settings this repo expects. Idempotent: safe to re-run.
#
# Run by a Botyard-AI org admin, with the GitHub CLI logged in:
#   gh auth login --scopes admin:org,repo
#   scripts/apply-repo-settings.sh            # apply
#   DRY_RUN=1 scripts/apply-repo-settings.sh  # print what it would do
#
# Every step is reported as ok/FAILED and the script continues, so one
# unsupported endpoint does not leave the rest unapplied. Re-run after fixing.
# What each setting is for: docs/repo-settings.md.
set -uo pipefail

REPO="${REPO:-Botyard-AI/create-botyard-app}"
ORG="${REPO%%/*}"
TEAM="${TEAM:-create-botyard-app-maintainers}"
ENVIRONMENT="${ENVIRONMENT:-npm-publish}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
failures=0

step() {
  local what="$1"; shift
  if [ -n "${DRY_RUN:-}" ]; then
    printf 'DRY   %s\n      %s\n' "$what" "$*"
    return 0
  fi
  local out
  if out="$("$@" 2>&1)"; then
    printf 'ok    %s\n' "$what"
  else
    printf 'FAILED %s\n%s\n' "$what" "$(printf '%s' "$out" | sed 's/^/      /' | head -5)"
    failures=$((failures + 1))
  fi
}

api() { gh api --silent -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$@"; }

# ---------------------------------------------------------------- team
step "team @$ORG/$TEAM exists (create it if missing)" \
  sh -c "gh api orgs/$ORG/teams/$TEAM --silent 2>/dev/null || gh api --silent -X POST orgs/$ORG/teams -f name=$TEAM -f privacy=closed -f description='Maintainers of create-botyard-app'"
step "team has maintain access to the repo" \
  api -X PUT "orgs/$ORG/teams/$TEAM/repos/$REPO" -f permission=maintain

# ---------------------------------------------------------------- repo
step "repo: squash merge only, delete merged branches, no wiki/projects" \
  api -X PATCH "repos/$REPO" --input - <<JSON
{
  "description": "Build web apps that run inside your Botyard bot and are served to your org as Bot Pages: npx create-botyard-app",
  "homepage": "https://botyard.io/features/bot-pages",
  "has_wiki": false,
  "has_projects": false,
  "has_issues": true,
  "has_discussions": true,
  "allow_squash_merge": true,
  "allow_merge_commit": false,
  "allow_rebase_merge": false,
  "allow_auto_merge": false,
  "allow_update_branch": true,
  "delete_branch_on_merge": true,
  "squash_merge_commit_title": "PR_TITLE",
  "squash_merge_commit_message": "PR_BODY",
  "web_commit_signoff_required": false,
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
JSON
step "repo topics" \
  api -X PUT "repos/$REPO/topics" --input - <<'JSON'
{ "names": ["botyard", "bot-pages", "ai-agents", "scaffolding", "create-app", "mcp", "model-context-protocol", "typescript", "react", "vite", "hono", "nextjs", "cli"] }
JSON

# ---------------------------------------------------------------- security
step "Dependabot alerts"               api -X PUT "repos/$REPO/vulnerability-alerts"
step "Dependabot security updates"     api -X PUT "repos/$REPO/automated-security-fixes"
step "private vulnerability reporting" api -X PUT "repos/$REPO/private-vulnerability-reporting"
step "immutable releases"              api -X PUT "repos/$REPO/immutable-releases"
# Needs at least one JavaScript/TypeScript file on main; re-run once code lands.
step "CodeQL default setup" \
  api -X PATCH "repos/$REPO/code-scanning/default-setup" -f state=configured -f query_suite=extended

# ---------------------------------------------------------------- actions
step "actions: only allow-listed actions, pinned to full SHAs" \
  api -X PUT "repos/$REPO/actions/permissions" --input - <<'JSON'
{ "enabled": true, "allowed_actions": "selected", "sha_pinning_required": true }
JSON
step "actions: allow-list" \
  api -X PUT "repos/$REPO/actions/permissions/selected-actions" --input - <<'JSON'
{
  "github_owned_allowed": true,
  "verified_allowed": false,
  "patterns_allowed": [
    "pnpm/action-setup@*",
    "ossf/scorecard-action@*",
    "zizmorcore/zizmor-action@*"
  ]
}
JSON
step "actions: read-only GITHUB_TOKEN, cannot approve PRs" \
  api -X PUT "repos/$REPO/actions/permissions/workflow" --input - <<'JSON'
{ "default_workflow_permissions": "read", "can_approve_pull_request_reviews": false }
JSON
step "actions: approval required for every outside contributor's workflow run" \
  api -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" -f approval_policy=all_external_contributors

# ---------------------------------------------------------------- environment
team_id="$(gh api "orgs/$ORG/teams/$TEAM" --jq .id 2>/dev/null || echo '')"
step "environment $ENVIRONMENT: main only, team approval, no self-review" \
  api -X PUT "repos/$REPO/environments/$ENVIRONMENT" --input - <<JSON
{
  "wait_timer": 0,
  "prevent_self_review": true,
  "reviewers": [{ "type": "Team", "id": ${team_id:-0} }],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
JSON
step "environment $ENVIRONMENT: allow branch main" \
  sh -c "gh api repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies --jq '.branch_policies[].name' | grep -qx main || gh api --silent -X POST repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies -f name=main -f type=branch"

# ---------------------------------------------------------------- rulesets
for file in "$ROOT"/.github/rulesets/*.json; do
  name="$(node -p "require('$file').name")"
  id="$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$name\") | .id" 2>/dev/null || echo '')"
  if [ -n "$id" ]; then
    step "ruleset $name (update #$id)" api -X PUT "repos/$REPO/rulesets/$id" --input "$file"
  else
    step "ruleset $name (create)" api -X POST "repos/$REPO/rulesets" --input "$file"
  fi
done

echo
if [ "$failures" -eq 0 ]; then echo "All settings applied."; else echo "$failures step(s) failed; see above."; exit 1; fi
