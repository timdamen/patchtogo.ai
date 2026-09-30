# How it works

::: warning Early days
patchtogo is being set up. This page describes the intended flow, not a running service.
:::

## The flow

1. **Advisory detected.** A new GitHub Security Advisory for an npm package comes in, together with its context: advisory text, affected version range and any upstream discussion.
2. **Triage.** A deterministic check runs first, without a model: a package is only a candidate while its latest version on npm still falls inside the vulnerable range. An advisory without a "first patched version" is not enough, because many of those are stale (newer releases already left the range). Malware advisories are never candidates, and a range the check can't parse goes to a human rather than being guessed. For the remaining packages the agent decides whether a small, behaviour-preserving fix can close the issue.
3. **Fork and verify.** The package's repository is forked into the [patchtogo-ai](https://github.com/patchtogo-ai) organisation and checked out at the commit of the latest vulnerable release. That commit is built in a sandbox, and its packed files are compared with the published npm tarball, so the patch applies to what users actually run. A package without a public GitHub repository, without a commit or tag for the release, or whose build differs from the tarball goes to a human instead.
4. **Fix and pull request.** In a sandbox, the agent writes the patch and an exploit regression test. The sandbox then re-runs that test itself: it has to fail on the base branch and pass with the fix. Only then does the agent commit the diff to a patch branch, `ptg/patch/<name>/<version>/<ghsa-id>`, and open a public pull request against the base branch. The pull request describes the vulnerability, the triage reasoning, the fix strategy and the test results, and requests a review from the reviewer team. A fix that doesn't go from red to green, or whose diff touches the scaffolding (workflows, CODEOWNERS, the notice), goes to a human instead.
5. **Preview release.** Every commit on the pull request is published as a preview build through [pkg.pr.new](https://pkg.pr.new), and the pull request description carries the install link for the first one. Previews are **unreviewed** and meant as an emergency stopgap: their version is the patched version plus `.preview-<commit>`, and their README opens with an "unreviewed preview" warning. See [Preview builds](#preview-builds).
6. **Review.** Reviewers comment on the pull request and the agent iterates on their feedback. Only comments from the reviewer team are treated as instructions. See [the review loop](#the-review-loop).
7. **Stable release.** After two approvals a human merges, and GitHub Actions publishes `@patchtogo.ai/<package>` with npm provenance.

## The review loop

Anyone can comment on a patch pull request, but only some comments make the agent act:

- **Reviewer team.** A conversation comment or a submitted review (its text plus its inline comments, handled together as one piece of feedback) from an active member of the reviewer team is an instruction. The agent resumes the fix session it used for the pull request, from the transcript it keeps in its database, and pushes the result as a new commit on top of the patch branch. Every push builds a new, equally unreviewed preview. It then replies on the pull request with what changed and the re-run test results. If the new diff isn't red to green, or doesn't apply, it pushes nothing and says why; if the fixer decides no change is needed, it answers without a commit. Approvals never start an iteration.
- **Everyone else.** Comments from people outside the team (invited members who haven't accepted count as outside) never start an iteration. They are kept and handed to the next reviewer-triggered iteration as clearly marked, untrusted context, so useful outside input isn't lost but can't steer the patch.
- **Bots.** Comments by any bot account, including patchtogo's own replies and preview-build comments, are ignored, so the agent can't trigger itself.
- **Hand-over.** A reviewer who wants humans to take over writes `/patchtogo hand-over` on a line of its own, or adds the `patchtogo: hand over` label. The run moves to needs-human, the reviewer channel is notified, the agent confirms on the pull request, and from then on it ignores the pull request.
- **Human commits.** The agent only ever fast-forwards the patch branch from its own last commit. If someone else pushed to the branch, it doesn't overwrite their work: it pushes nothing, says so on the pull request and hands the run over to humans.

Each comment is handled once, even when GitHub delivers it again, and the comments on one pull request are handled one after another. Review iterations only run with `PTG_AUTOMATION=full`; at a lower level reviewer feedback waits, and `pnpm --filter agent retry <GHSA-id>` picks it up once the level is raised. Each iteration gets its own short-lived model token and its cost is recorded with the run.

## Using a patched package

Point the vulnerable dependency at the patched fork with your package manager's overrides. With npm, in `package.json`:

```json
{
  "overrides": {
    "lodash.set": "npm:@patchtogo.ai/lodash.set@4.3.2-ptg.1"
  }
}
```

pnpm reads the same mapping from `overrides` in `pnpm-workspace.yaml`, and Yarn from `resolutions` in `package.json`.

## Names and versions

- An unscoped package `foo` is published as `@patchtogo.ai/foo`, and a scoped package `@scope/foo` as `@patchtogo.ai/scope__foo`.
- Versions are the upstream version plus `-ptg.N`, where N counts patchtogo's stable releases of that upstream version. They are prereleases in semver terms, so pin the exact version in your overrides.
- Each fork has a base branch per upstream version, `ptg/base/<name>/<version>` (with `<name>` being `foo` or `scope__foo`). It holds the upstream release plus one "patchtogo scaffolding" commit: the rename and version, `repository` pointing at the fork, an unofficial-fork banner in the README, a `PATCHTOGO.md` attribution and licence notice, CODEOWNERS for the reviewer team, and the patchtogo preview workflow instead of the upstream workflows. Patch pull requests target that branch, so their diff shows only the fix.

## Preview builds

The scaffolding commit adds `.github/workflows/patchtogo-preview.yml` to the base branch, so every patch branch inherits it. The workflow:

- runs only on pushes to `ptg/patch/**` branches in the fork itself. It has no `pull_request` or `pull_request_target` trigger, so a pull request from someone else's fork never builds or publishes anything, and each job checks that it runs in the patchtogo fork, so a fork of the fork that enables Actions does not publish either. Only the agent, the reviewer team and organisation owners can push to the fork.
- holds no secrets and no `id-token` permission. The build job reads the repository (`contents: read`), and the publish job gets no token permissions at all. pkg.pr.new authenticates the upload through its own GitHub App, which checks that the workflow run is real.
- builds the package with the same script as the tarball-match check (lockfile-aware install, the `build` script, pack), in the package's directory, after setting the version to `<version>-ptg.N.preview-<commit>` and prepending the warning to the README. The build job hands the tarball to a separate publish job, which runs a pinned `pkg-pr-new` without checking out or building anything.
- pins every action to a commit SHA.

Install a preview with the link from the pull request, for example `npm i https://pkg.pr.new/patchtogo-ai/escape-html/@patchtogo.ai/escape-html@<commit>`. pkg.pr.new also comments on the pull request with the link for the latest commit.

Base branches cut before the preview workflow existed get it when a later run reuses them: the agent adds the missing workflow in one "update the patchtogo scaffolding" commit on top of the base branch and changes nothing else. It only adds missing files and never overwrites a workflow that is present, so changes to a workflow on an existing base branch go through a reviewed pull request. An open patch pull request cut from the older base branch keeps its old head until it is rebased onto the updated base branch.

## Automation level

The agent service reads `PTG_AUTOMATION`:

- `triage-only` (the default): runs stop after triage. Nothing is forked and no model spend goes to fixing.
- `fork`: runs are forked and verified, then stop before the fix.
- `full`: runs go all the way to an open patch pull request.

A run held back by a lower level waits in `triaged` or `fixing`. After raising the level, `pnpm --filter agent retry <GHSA-id>` resumes it from where it stopped.

The sandbox reaches the model only through the agent's model proxy, with a token that is issued for one fix and revoked as soon as the fix ends, whether it succeeded or not. The fix session's transcript is stored in Postgres, outside the sandbox, so a review iteration can resume the same session.

## Running the agent service

The agent service is a Fastify server on Node's own HTTP stack. It serves `/health`, the GitHub webhook and the model proxy, and forwards model requests to Anthropic with undici, streaming the response back as it arrives. Cancelling a proxied request, or disconnecting mid-stream, cancels the request to Anthropic too.

Request bodies are capped, and a larger body gets a 413 while it is still arriving, before it is buffered or its signature is checked:

- `PTG_WEBHOOK_MAX_MB` (default 25): GitHub caps webhook payloads at 25 MB and doesn't deliver larger ones.
- `PTG_MODEL_PROXY_MAX_MB` (default 32): the Messages and Token Counting APIs reject requests over 32 MB.

The request log is JSON (Pino) and includes request headers, with `authorization`, `x-api-key`, cookies and webhook signatures redacted.

On `SIGTERM` (a Railway redeploy gives the old instance 30 seconds) the service stops polling and accepting connections, gives open requests 10 seconds before cutting any proxy stream still running, and gives pg-boss 20 seconds to finish the jobs in flight, all within a 25-second deadline. It exits 0 when that completes and 1 when it doesn't. A fix session can run for 40 minutes, so shutdown doesn't wait for one: pg-boss fails the job it was part of, and retries it (up to 3 times, with backoff) on the next instance, which picks the run up from the state it was in and starts the fix step again. An uncaught exception or unhandled rejection is logged, goes through the same shutdown, and exits 1, so Railway restarts the service.
