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
    "ref_name": { "include": ["refs/heads/ptg/base/**/*"], "exclude": [] },
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
- `required_reviewers` (team 19769979 is `reviewers`) makes both approvals come from the reviewer team. It is in beta on GitHub. If the API refuses it, leave it out: CODEOWNERS (`* @patchtogo-ai/reviewers`) then requires one approval from the reviewer team, and the second approval stays inside the team only as long as nobody else has write access to the forks (organisation base permission "Read" or "No permission", and no outside collaborators).
- `require_last_push_approval` means an approval given before the agent's last push doesn't count, so every review iteration needs fresh approvals.
- If the organisation's plan has no organisation rulesets, create the same ruleset on each fork (`POST repos/patchtogo-ai/<fork>/rulesets`). The agent accepts either.

The ruleset doesn't stop the App from creating a base branch (one ref at the scaffolding commit), only from changing one afterwards.

Before it opens a patch pull request, and before it pushes a scaffolding update to a base branch, the agent reads the rules that apply to the base branch (`GET /repos/{owner}/{repo}/rules/branches/{branch}`, plus each ruleset's `current_user_can_bypass`, and the organisation's teams to name the teams in `required_reviewers`). The branch counts as protected only when an active ruleset that patchtogo can't bypass requires two approvals, a code owner review and approval of the last push, and in addition either:

- that ruleset's `required_reviewers` asks for at least two approvals from the reviewer team on every file (file pattern `*`, `**` or `**/*`), or
- no rule on the branch has `required_reviewers` at all, because GitHub didn't accept or doesn't return it, and `.github/CODEOWNERS` on the base branch names the reviewer team and nobody else, with a `*` pattern. This fallback relies on the write-access condition above for the second approval; the agent can't check that.

A `required_reviewers` entry for another team, for too few approvals or for only some files doesn't count, and the fallback doesn't apply once any rule has one. Otherwise the run fails at `fixing` without a pull request and keeps its fix. Create the ruleset and retry the run. Until the ruleset exists, `PTG_AUTOMATION=full` stops every run before its pull request.

### Release environment

The stable release workflow publishes from the `patchtogo-release` deployment environment, and npm trusts it only from there. The agent creates the environment on every fork during `verifying`, before it cuts or reuses a base branch, with one deployment branch policy, `ptg/base/*/*`, and it deletes any other policy it finds. Forks from before the environment existed get it on their next run, together with a scaffolding update that adds `environment: patchtogo-release` to their publish job.

Without the environment, the workflow file on any branch of a fork could ask for an OIDC token that npm accepts: the reviewer team has write access, so one reviewer could push a branch that publishes with provenance and skip the two approvals. With it, only a run on a base branch reaches npm, and base branches change only through reviewed pull requests.

A base branch can still be created by anyone with write access. To close that too, add a second organisation ruleset for `refs/heads/ptg/base/**/*` with only the `creation` rule and the patchtogo GitHub App as its one bypass actor, so only the App can create base branches. Keep it separate from the pull request ruleset, which must stay without bypass actors.

```sh
gh api -X POST orgs/patchtogo-ai/rulesets --input - <<'JSON'
{
  "name": "patchtogo base branch creation",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["refs/heads/ptg/base/**/*"], "exclude": [] },
    "repository_name": { "include": ["~ALL"], "exclude": [] }
  },
  "bypass_actors": [
    { "actor_id": <GitHub App id>, "actor_type": "Integration", "bypass_mode": "always" }
  ],
  "rules": [{ "type": "creation" }]
}
JSON
```

Ruleset branch patterns are not Actions branch filters: a trailing `**` matches only one path segment, so `refs/heads/ptg/base/**` would miss every `ptg/base/<slug>/<version>` branch. Use `refs/heads/ptg/base/**/*`, and confirm with `gh api repos/patchtogo-ai/<fork>/rules/branches/ptg/base/<slug>/<version>`, which must list the `pull_request` rule. Organisation rulesets need the GitHub Team plan (or higher), and the `gh` token needs the `admin:org` scope (`gh auth refresh -h github.com -s admin:org`).

### GitHub App

It creates the release environment and its branch policy with Administration (read and write), which it already needs to set the default branch and enable Actions on a fork. It reads rules with Metadata, pull request merges with Pull requests and workflow runs with Actions (read). Actions stays read-only on purpose, so the App can't re-run or start a release: re-running a failed release workflow is a human's click, or `gh run rerun <run id> --failed -R patchtogo-ai/<fork>`.

**Organisation permission Members: Read.** The agent asks GitHub whether a comment's author is an active member of the reviewer team, and it lists the organisation's teams to name the teams in a ruleset's `required_reviewers`. Without it GitHub answers both with "Resource not accessible by integration": every reviewer comment, review and hand-over label fails in the queue instead of reaching the run, so reviewers get no iteration and no reply, and every run with team reviewers in its ruleset fails at `fixing` before its patch pull request. The reviewer channel hears about neither; only `pnpm --filter agent retry` lists them.

**Webhook subscriptions.** The App has to be subscribed to these events. GitHub delivers nothing it isn't subscribed to, and the agent can't tell a missing subscription from a quiet day:

| Event                         | What the agent does with it                                    | Without it                                                                                      |
| ----------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `issue_comment`               | conversation comments on a patch pull request                  | reviewers' comments never reach the agent                                                       |
| `pull_request_review`         | submitted reviews, with their inline comments                  | reviews never start an iteration                                                                |
| `pull_request_review_comment` | inline comments posted on their own                            | single inline comments are lost                                                                 |
| `pull_request`                | the hand-over label, and a patch pull request closed or merged | a merge never moves the run to `approved`, and a closed pull request never ends the review loop |
| `workflow_run`                | the stable release workflow finishing                          | a release stays in `approved` until someone runs `pnpm --filter agent retry <run>`              |
| `security_advisory`           | new and updated GitHub advisories                              | advisories arrive only with the next poll, up to `PTG_POLL_INTERVAL_MINUTES` later              |

### npm

- The `patchtogo.ai` npm organisation owns the scope. Publishing the placeholder and `npm trust` need an owner with 2FA.
- Each new package needs the one-time bootstrap from [How it works](/how-it-works#the-first-release-of-a-package). The needs-human message has the commands filled in for the package. The trusted publisher names the workflow and the environment:

  ```bash
  npm trust github @patchtogo.ai/<name> --repo patchtogo-ai/<fork> \
    --file patchtogo-release.yml --environment patchtogo-release --allow-publish --yes
  ```

  A package trusted without `--environment` accepts a publish from any branch of its fork. Replace such a trusted publisher with this one.

- `npm deprecate` can't use trusted publishing, so superseded packages are deprecated by hand. The "Superseded upstream" message in the reviewer channel has the command for the package and version.

### Upstream pull requests

The GitHub App can push the upstream-ready branch to the fork, but it can't open a pull request on an upstream repository. To let the agent open those itself, create a dedicated machine user, give it a classic personal access token with only the `public_repo` scope (fine-grained tokens can't write to other owners' repositories), and set it as `PTG_UPSTREAM_TOKEN` on Railway. The account needs no access to the `patchtogo-ai` forks. Without the token, open each pull request from the compare link in the reviewer channel and then run `pnpm --filter agent retry <run>`.

The upstream branch carries the upstream repository's own workflow files, so pushing it runs upstream's `on: push` workflows in the fork. Set the organisation's default `GITHUB_TOKEN` permissions to read-only so they can't write to the fork.

### Forks from before stable releases

The base branches of `patchtogo-ai/escape-html` and `patchtogo-ai/clsx` predate both workflows. Their next run adds the workflows: in one commit while the ruleset doesn't exist yet, and as a scaffolding pull request for the reviewers once it does.

## Security advisories

patchtogo publishes repository security advisories on its forks for later upstream advisories (see [How it works](/how-it-works#security-coverage)).

- **GitHub App permission.** The App needs the repository permission **Repository security advisories: Read and write** (`repository_advisories: write`) on the `patchtogo-ai` installation. It lists a fork's advisories, creates one as a draft and publishes it by setting its state to `published`, and later updates its affected and patched versions. The installation has it; an App set up from scratch needs it added under the App's permissions, and the organisation owner has to accept the new permission.
- **Notifications.** The reviewer channel gets "Advisory published" when a patched package is affected, and "Advisory patched" when the follow-up release fixes it. The follow-up run itself notifies like any other run (patch PR ready, needs a human).
- **Failures.** If publishing fails, the queue job for that advisory fails after its retries, while the follow-up run carries on. `pnpm --filter agent retry` lists it among the failed advisories and `pnpm --filter agent retry <GHSA-id>` delivers it again. If the update at release time fails, the run fails at `approved`; `pnpm --filter agent retry <run>` redoes it.
- **Needs-human follow-ups.** Leave the advisory published without a patched version. If humans finish the follow-up's pull request and merge it, its release still marks the advisory patched when the run reaches `released`. To stop reporting a package, close or withdraw the advisory on GitHub; the agent leaves closed and withdrawn advisories alone.
