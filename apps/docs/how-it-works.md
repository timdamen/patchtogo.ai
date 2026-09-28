# How it works

::: warning Early days
patchtogo is being set up. This page describes the intended flow, not a running service.
:::

## The flow

1. **Advisory detected.** A new GitHub Security Advisory for an npm package comes in, together with its context: advisory text, affected version range and any upstream discussion.
2. **Triage.** The agent decides whether a small, behaviour-preserving fix can close the issue. Packages that already have an upstream fix are skipped.
3. **Fork and verify.** The package's repository is forked into the [patchtogo-ai](https://github.com/patchtogo-ai) organisation and checked out at the commit of the latest vulnerable release. That commit is built in a sandbox, and its packed files are compared with the published npm tarball, so the patch applies to what users actually run. A package without a public GitHub repository, without a commit or tag for the release, or whose build differs from the tarball goes to a human instead.
4. **Fix and pull request.** The agent writes the patch and an exploit regression test, then opens a public pull request.
5. **Preview release.** Every commit on the pull request is published as a preview build. Previews are **unreviewed** and meant as an emergency stopgap.
6. **Review.** Reviewers comment on the pull request and the agent iterates on their feedback. Only comments from the reviewer team are treated as instructions.
7. **Stable release.** After two approvals a human merges, and GitHub Actions publishes `@patchtogo.ai/<package>` with npm provenance.

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
- Each fork has a base branch per upstream version, `ptg/base/<name>/<version>` (with `<name>` being `foo` or `scope__foo`). It holds the upstream release plus one "patchtogo scaffolding" commit: the rename and version, `repository` pointing at the fork, an unofficial-fork banner in the README, a `PATCHTOGO.md` attribution and licence notice, CODEOWNERS for the reviewer team, and no upstream workflows. Patch pull requests target that branch, so their diff shows only the fix.
