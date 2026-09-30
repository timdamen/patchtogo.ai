# Operations

Notes for whoever runs the patchtogo service and the [patchtogo-ai](https://github.com/patchtogo-ai) organisation.

## Preview builds

Preview builds need, once per organisation:

- **The pkg.pr.new GitHub App** (https://github.com/apps/pkg-pr-new), installed on `patchtogo-ai` with access to **all repositories**. Every patched package lives in a new fork, and an installation limited to selected repositories would miss each new fork until someone adds it by hand. pkg.pr.new refuses uploads from repositories its App cannot see. It is installed (installation 165905303, since 2026-09-28).
- **GitHub Actions allowed in the organisation**, including `actions/checkout`, `actions/setup-node`, `actions/upload-artifact` and `actions/download-artifact`. Forks start with Actions disabled; the agent enables Actions on each fork after it has deleted every branch outside `ptg/`.

Nothing else is configured: the preview workflow holds no secrets, and pushes by the patchtogo GitHub App trigger workflows (only pushes made with a workflow's own `GITHUB_TOKEN` do not).

The pkg.pr.new comment on a patch pull request comes from the `pkg-pr-new[bot]` account. It is not a reviewer comment.

## Stable releases

### Protect the base branches once

Every base branch needs a ruleset that requires two approvals and that nobody, the patchtogo GitHub App included, can bypass. The App has no organisation administration permission, so an organisation owner creates one ruleset for the whole organisation:

```bash
gh api -X POST orgs/patchtogo-ai/rulesets --input - <<'JSON'
{
  "name": "patchtogo base branches",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": { "include": ["refs/heads/ptg/base/**"], "exclude": [] },
    "repository_name": { "include": ["~ALL"], "exclude": [] }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 2,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": false,
        "required_reviewers": [
          { "reviewer": { "id": 19769979, "type": "Team" }, "file_patterns": ["*"], "minimum_approvals": 2 }
        ]
      }
    }
  ]
}
JSON
```

- `bypass_actors` stays empty: no role, team or app can merge without the reviews, and the App can't push to a base branch.
- `required_reviewers` (team 19769979 is `reviewers`) is in beta on GitHub. If the API refuses it, leave it out: CODEOWNERS (`* @patchtogo-ai/reviewers`) still requires an approval from the reviewer team, and giving only the reviewer team write access to the forks keeps the second approval inside the team too.
- `require_last_push_approval` means an approval given before the agent's last push doesn't count, so every review iteration needs fresh approvals.
- If the organisation's plan has no organisation rulesets, create the same ruleset on each fork (`POST repos/patchtogo-ai/<fork>/rulesets`). The agent accepts either.

The ruleset doesn't stop the App from creating a base branch (one ref at the scaffolding commit), only from changing one afterwards.

Before it opens a patch pull request, the agent reads the rules that apply to the base branch (`GET /repos/{owner}/{repo}/rules/branches/{branch}`, plus each ruleset's `current_user_can_bypass`). Unless one active ruleset requires two approvals, a code owner review and approval of the last push, and patchtogo can't bypass it, the run fails at `fixing` without a pull request and keeps its fix. Create the ruleset and retry the run. Until the ruleset exists, `PTG_AUTOMATION=full` stops every run before its pull request.

### GitHub App

The App needs no new permissions. It reads rules with Metadata, pull request merges with Pull requests and workflow runs with Actions (read), and it is already subscribed to the `pull_request` and `workflow_run` webhooks. Actions stays read-only on purpose, so the App can't re-run or start a release: re-running a failed release workflow is a human's click, or `gh run rerun <run id> --failed -R patchtogo-ai/<fork>`.

### npm

- The `patchtogo.ai` npm organisation owns the scope. Publishing the placeholder and `npm trust` need an owner with 2FA.
- Each new package needs the one-time bootstrap from [How it works](/how-it-works#the-first-release-of-a-package). The needs-human message has the commands filled in for the package.
- `npm deprecate` can't use trusted publishing, so superseded packages are deprecated by hand. The "Superseded upstream" message in the reviewer channel has the command for the package and version.

### Upstream pull requests

The GitHub App can push the upstream-ready branch to the fork, but it can't open a pull request on an upstream repository. To let the agent open those itself, create a dedicated machine user, give it a classic personal access token with only the `public_repo` scope (fine-grained tokens can't write to other owners' repositories), and set it as `PTG_UPSTREAM_TOKEN` on Railway. The account needs no access to the `patchtogo-ai` forks. Without the token, open each pull request from the compare link in the reviewer channel and then run `pnpm --filter agent retry <run>`.

The upstream branch carries the upstream repository's own workflow files, so pushing it runs upstream's `on: push` workflows in the fork. Set the organisation's default `GITHUB_TOKEN` permissions to read-only so they can't write to the fork.

### Forks from before stable releases

The base branches of `patchtogo-ai/escape-html` and `patchtogo-ai/clsx` predate both workflows. Their next run adds the workflows: in one commit while the ruleset doesn't exist yet, and as a scaffolding pull request for the reviewers once it does.
