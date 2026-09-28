# Why patchtogo.ai

## No ship = no fun

We're a frontend platform team at [ABN AMRO](https://www.abnamro.nl), and some weeks we see four CVEs. When one of them hits an active project through a package our team provides, everyone looks at us to ship the security patch as soon as possible. When that patch takes a long time, or never comes at all, no team can ship without a waiver. A day without shipping is a day without fun.

> No ship = no fun<br>
> No fun = much sad

## The problem

When a security advisory lands on an npm package whose maintainer hasn't shipped a fix, every project that depends on it, directly or through another package, is stuck. `npm audit` and Dependabot keep failing, and teams can't do much about it:

- **Wait**, possibly forever if the package is abandoned.
- **Drop the dependency**, which is often impossible when it's transitive.
- **Hand-patch it** with `patch-package`, which each team repeats in isolation and nobody reviews.

The fixes involved are often small, but there is no trusted, shared source for them. A random fork published by a stranger looks exactly like a supply-chain attack. Commercial vendors exist, but they're closed and paid.

## The solution

patchtogo watches the GitHub Advisory Database for npm advisories that have no patched version. For each affected package it:

1. triages whether a small, behaviour-preserving fix can close the vulnerability
2. forks the package into the patchtogo GitHub organisation
3. checks that the fork really matches what's published on npm
4. has an AI agent write the fix plus an exploit regression test, working in a sandbox
5. opens a public patch PR

Every commit on the patch PR is published right away as a preview release through [pkg.pr.new](https://pkg.pr.new). Previews are clearly labelled as **unreviewed** and serve as an emergency stopgap.

A named reviewer team reviews the patch PR. The agent iterates on their comments, and only on their comments. After two reviewer approvals a human merges. The merge publishes a stable release, `@patchtogo/<package>`, from GitHub Actions with npm provenance, so anyone can trace the tarball back to the exact commit.

Consumers adopt a patch by pointing the vulnerable dependency at the patched package with their package manager's overrides. See [How it works](/how-it-works#using-a-patched-package) for an example.
