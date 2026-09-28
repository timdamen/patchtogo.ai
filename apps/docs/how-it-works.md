# How it works

::: warning Early days
patchtogo is being set up. This page describes the intended flow, not a running service.
:::

## The flow

1. **Advisory detected.** A new GitHub Security Advisory for an npm package comes in, together with its context: advisory text, affected version range and any upstream discussion.
2. **Triage.** The agent decides whether a small, behaviour-preserving fix can close the issue. Packages that already have an upstream fix are skipped.
3. **Fork and verify.** The package is forked and its build output is compared against the published npm tarball, so the patch applies to what users actually run.
4. **Fix and pull request.** The agent writes the patch and an exploit regression test, then opens a public pull request.
5. **Preview release.** Every commit on the pull request is published as a preview build. Previews are **unreviewed** and meant as an emergency stopgap.
6. **Review.** Reviewers comment on the pull request and the agent iterates on their feedback. Only comments from the reviewer team are treated as instructions.
7. **Stable release.** After two approvals a human merges, and GitHub Actions publishes `@patchtogo/<package>` with npm provenance.

## Using a patched package

Point the vulnerable dependency at the patched fork with your package manager's overrides. With npm, in `package.json`:

```json
{
  "overrides": {
    "lodash.set": "npm:@patchtogo/lodash.set@^4.3.2-ptg.1"
  }
}
```

pnpm reads the same mapping from `overrides` in `pnpm-workspace.yaml`, and Yarn from `resolutions` in `package.json`.
