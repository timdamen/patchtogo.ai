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
7. **Stable release.** After two approvals from the reviewer team a human merges, and GitHub Actions publishes `@patchtogo.ai/<package>` with npm provenance, so the tarball traces back to the merge commit. See [Stable releases](#stable-releases).
8. **Upstream pull request.** The fix and its regression test, without any patchtogo scaffolding, are proposed to the upstream repository. See [Upstreaming and superseding](#upstreaming-and-superseding).
9. **Superseded.** Once an upstream release fixes the advisory, the patched package is deprecated in favour of it.
10. **Security coverage.** When a new advisory hits the upstream package and covers the version a released patched package is built from, patchtogo publishes an advisory for the patched package too and starts a follow-up fix on top of its latest stable release. See [Security coverage](#security-coverage).

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
- Each fork has a base branch per upstream version, `ptg/base/<name>/<version>` (with `<name>` being `foo` or `scope__foo`). It holds the upstream release plus one "patchtogo scaffolding" commit: the rename and version, `repository` pointing at the fork, an unofficial-fork banner in the README, a `PATCHTOGO.md` attribution and licence notice, CODEOWNERS for the reviewer team, and the patchtogo preview and stable release workflows instead of the upstream workflows. Patch pull requests target that branch, so their diff shows only the fix.

## Preview builds

The scaffolding commit adds `.github/workflows/patchtogo-preview.yml` to the base branch, so every patch branch inherits it. The workflow:

- runs only on pushes to `ptg/patch/**` branches in the fork itself. It has no `pull_request` or `pull_request_target` trigger, so a pull request from someone else's fork never builds or publishes anything, and each job checks that it runs in the patchtogo fork, so a fork of the fork that enables Actions does not publish either. Only the agent, the reviewer team and organisation owners can push to the fork.
- holds no secrets and no `id-token` permission. The build job reads the repository (`contents: read`), and the publish job gets no token permissions at all. pkg.pr.new authenticates the upload through its own GitHub App, which checks that the workflow run is real.
- builds the package with the same script as the tarball-match check (lockfile-aware install, the `build` script, pack), in the package's directory, after setting the version to `<version>-ptg.N.preview-<commit>` and prepending the warning to the README. The build job hands the tarball to a separate publish job, which runs a pinned `pkg-pr-new` without checking out or building anything.
- pins every action to a commit SHA.

Install a preview with the link from the pull request, for example `npm i https://pkg.pr.new/patchtogo-ai/escape-html/@patchtogo.ai/escape-html@<commit>`. pkg.pr.new also comments on the pull request with the link for the latest commit.

Base branches cut before a patchtogo workflow existed get it when a later run reuses them. The agent only adds missing files and never overwrites a workflow that is present, so changes to a workflow on an existing base branch go through a reviewed pull request:

- On a base branch that isn't protected yet, it adds the missing workflows in one "update the patchtogo scaffolding" commit on top of the base branch and changes nothing else.
- On a protected base branch it can't push, so it opens that same commit as a pull request from `ptg/scaffolding/<name>/<version>`, requests the reviewer team and fails the run at `verifying` with the link. Once reviewers have merged it, `pnpm --filter agent retry <run>` carries on. It never asks for a way around the protection.

Neither kind of update publishes anything (see [Stable releases](#stable-releases)). An open patch pull request cut from the older base branch keeps its old head until it is rebased onto the updated base branch.

## Stable releases

The scaffolding commit also adds `.github/workflows/patchtogo-release.yml`. The workflow:

- runs on pushes to `ptg/base/**` in the patchtogo fork, and a first `gate` job asks GitHub which pull request the pushed commit merged. Only the merge of a patch pull request (head `ptg/patch/…` in the same fork) goes on; the push that creates a base branch, a scaffolding update and anything else pushed to a base branch publish nothing. Every job also checks that it runs in the patchtogo fork.
- builds in one job and publishes in another. The `gate` job reads pull requests, the `build` job reads the repository and runs the package's own build with the same script as the tarball-match check, and only the `publish` job may request an OIDC token (`id-token: write`). The publish job doesn't check out or build anything: it downloads the tarball and runs `npm publish --provenance --access public --tag latest --ignore-scripts`. There is no npm token anywhere; npm trusted publishing swaps the job's OIDC token for a short-lived one.
- picks the version itself. It asks npm for the versions already published and releases `<upstream version>-ptg.<N+1>`, so a later fix for the same upstream version gets the next number. It also records the merge commit as `gitHead` in the published `package.json`.
- pins every action to a commit SHA, and runs the releases of one base branch one after another.

`-ptg.N` versions are semver prereleases, so the workflow always passes `--tag latest`, and consumers pin the exact version in their overrides.

The agent follows along through webhooks. Merging the patch pull request moves the run to `approved`. When the workflow run for that merge commit completes, the agent looks the package up on npm, and a version whose `gitHead` is the merge commit moves the run to `released`. A failed workflow run moves it to `failed` at the `approved` step, with the link to the workflow run. If someone re-runs the failed jobs and they succeed, the run continues without a retry; `pnpm --filter agent retry <run>` checks npm again, for example when that webhook was missed. The agent never merges and never publishes: the release is the workflow's job, started by a human's merge.

A patch pull request closed without being merged ends the review loop: the run moves to needs-human, and reopening the pull request doesn't resume it. A pull request the agent handed over to humans is still followed, so it's released when they merge it.

### The first release of a package

npm trusted publishing can only be set up for a package that already exists on npm, and npm can't trust a whole scope. When a patch pull request for a package that isn't on npm yet is merged, the run moves to needs-human with the commands for its package, and the release workflow for that merge fails. Once per package, an owner of the npm scope (npm 11.15 or later, 2FA on) runs:

```bash
mkdir ptg-seed && cd ptg-seed && npm init -y >/dev/null
npm pkg set name=@patchtogo.ai/escape-html version=0.0.0-ptg.0 \
  description="patchtogo placeholder, not a release" \
  repository.type=git repository.url=git+https://github.com/patchtogo-ai/escape-html.git
npm publish --access public --tag bootstrap
npm deprecate @patchtogo.ai/escape-html@0.0.0-ptg.0 "patchtogo placeholder, not a release"
npm trust github @patchtogo.ai/escape-html --repo patchtogo-ai/escape-html \
  --file patchtogo-release.yml --allow-publish --yes
```

and sets the package's publishing access to "Require two-factor authentication and disallow tokens" on npmjs.com. Re-running the failed jobs of the release workflow then publishes the real release, and the run moves to `released`. `pnpm --filter agent retry <run>` resumes the run too; it then waits for the next successful workflow run.

## Upstreaming and superseding

After the stable release the agent prepares a pull request for the upstream repository. It applies the fix diff to the upstream release commit the base branch was cut from, not to the base branch, and pushes that one commit to `ptg/upstream/<name>/<version>/<ghsa-id>` in the fork. The branch holds only the fix and the regression test, and its commit message carries the pull request title and description: the advisory, the reviewed patch pull request, the published version and the fixer's summary. Nothing is proposed, and the reviewer channel is told why, when the fix doesn't apply to the upstream release commit or when the merged patch pull request differs from the agent's fix (a human changed or added files before merging), because the agent can only vouch for its own fix.

The patchtogo GitHub App can't open a pull request on a repository it isn't installed on, so opening one needs a GitHub account:

- With `PTG_UPSTREAM_TOKEN` set, the agent opens the pull request from the fork's branch against the upstream default branch with that token, and the run moves to `upstreamed`.
- Without it, the reviewer channel gets a compare link that opens a pre-filled pull request. The run stays `released` until someone opens it; `pnpm --filter agent retry <run>` then finds the pull request (open, closed or merged) and moves the run to `upstreamed`.

Like the patch pull request, this only happens with `PTG_AUTOMATION=full`. A run released at a lower level waits in `released`, and a retry after raising the level carries on.

Every poll interval the agent also looks up the latest npm version of each upstream package it has released (runs in `released` or `upstreamed`). A new version only supersedes a patched package when the advisory, as GitHub shows it now, names a first patched version, the new version is at least that version, and it falls outside every vulnerable range of the advisory for that package. A newer version alone is not enough: an advisory without a patched version usually lists the vulnerable range up to the latest release it knew about, so a later release looks clean only because nobody checked it yet. The run then moves to `superseded`, and the reviewer channel gets the exact `npm deprecate` command for the patched release, with a message that points users back to the upstream version. The agent never publishes to npm, and npm trusted publishing can't deprecate, so an owner of the npm scope runs that command.

## Security coverage

`npm audit`, Dependabot and other scanners look advisories up by the package a dependency resolves to. Once you override `escape-html` with `@patchtogo.ai/escape-html`, an advisory filed later against `escape-html` no longer matches your lockfile, so patchtogo reports it for the patched package itself.

When an advisory is published or updated for a package that patchtogo has released (the run is `released` or `upstreamed`), the agent checks each line of patched releases, `<upstream version>-ptg.N`, against the advisory's vulnerable range. If the upstream version a line is built from is in the range:

- **It publishes a repository security advisory on the fork**, for example on `patchtogo-ai/escape-html`, for the npm package `@patchtogo.ai/escape-html`. It lists the affected versions (`>= 1.0.3-ptg.1`), links the upstream advisory and uses its severity. Published repository advisories go to the GitHub Advisory Database, and from there to OSV, so scanners warn you instead of staying silently green. The reviewer channel is told.
- **It starts a follow-up patch run** for the new advisory, `<GHSA-id>:<package>` like any other run, if the latest stable release is on an affected line. The follow-up skips forking and the tarball-match check: it builds on the base branch of that release, which already holds every merged fix, instead of on the latest upstream release, so the earlier fix is kept. Its triage doesn't skip the advisory because upstream has a patched version or because upstream's latest version left the range, since neither helps someone on the patched package. From there it's an ordinary run: fix, patch pull request, review, merge, and the next `-ptg.N` release.
- **When that release lands**, the agent updates the advisory: the affected range becomes `>= 1.0.3-ptg.1, < 1.0.3-ptg.2` and `1.0.3-ptg.2` is the patched version, and the reviewer channel is told again.
- **If the advisory can't be patched** (the follow-up goes to needs-human), the advisory stays published without a patched version, so you're warned rather than silently green.

Nothing happens for packages patchtogo never released, or when the range doesn't cover the upstream version our releases are built from. Advisories on `@patchtogo.ai/*` packages themselves, including the ones patchtogo publishes, are never patch candidates. Each patched package's README links the fork's advisories.

The agent finds its own advisory on the fork again by the "Upstream advisory" link in its description, so a redelivered advisory never creates a second one, and one that was created but not yet published is published on the next delivery. It doesn't touch an advisory someone closed or withdrew.

## Automation level

The agent service reads `PTG_AUTOMATION`:

- `triage-only` (the default): runs stop after triage. Nothing is forked and no model spend goes to fixing.
- `fork`: runs are forked and verified, then stop before the fix.
- `full`: runs go all the way to an open patch pull request, and released runs on to an upstream pull request.

A run held back by a lower level waits in `triaged` or `fixing`. After raising the level, `pnpm --filter agent retry <GHSA-id>` resumes it from where it stopped.

The sandbox reaches the model only through the agent's model proxy, with a token that is issued for one fix and revoked as soon as the fix ends, whether it succeeded or not. The fix session's transcript is stored in Postgres, outside the sandbox, so a review iteration can resume the same session.

## Running the agent service

The agent service is a Fastify server on Node's own HTTP stack. It serves `/health`, the GitHub webhook and the model proxy, and forwards model requests to Anthropic with undici, streaming the response back as it arrives. Cancelling a proxied request, or disconnecting mid-stream, cancels the request to Anthropic too.

Request bodies are capped, and a larger body gets a 413 while it is still arriving, before it is buffered or its signature is checked:

- `PTG_WEBHOOK_MAX_MB` (default 25): GitHub caps webhook payloads at 25 MB and doesn't deliver larger ones.
- `PTG_MODEL_PROXY_MAX_MB` (default 32): the Messages and Token Counting APIs reject requests over 32 MB.

The request log is JSON (Pino) and includes request headers, with `authorization`, `x-api-key`, cookies and webhook signatures redacted.

On `SIGTERM` (a Railway redeploy gives the old instance 30 seconds) the service stops polling and accepting connections, gives open requests 10 seconds before cutting any proxy stream still running, and gives pg-boss 20 seconds to finish the jobs in flight, all within a 25-second deadline. It exits 0 when that completes and 1 when it doesn't. A fix session can run for 40 minutes, so shutdown doesn't wait for one: pg-boss fails the job it was part of, and retries it (up to 3 times, with backoff) on the next instance, which picks the run up from the state it was in and starts the fix step again. An uncaught exception or unhandled rejection is logged, goes through the same shutdown, and exits 1, so Railway restarts the service.
