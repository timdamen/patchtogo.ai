# Operations

Notes for whoever runs the patchtogo service and the [patchtogo-ai](https://github.com/patchtogo-ai) organisation.

## Preview builds

Preview builds need, once per organisation:

- **The pkg.pr.new GitHub App** (https://github.com/apps/pkg-pr-new), installed on `patchtogo-ai` with access to **all repositories**. Every patched package lives in a new fork, and an installation limited to selected repositories would miss each new fork until someone adds it by hand. pkg.pr.new refuses uploads from repositories its App cannot see. It is installed (installation 165905303, since 2026-09-28).
- **GitHub Actions allowed in the organisation**, including `actions/checkout`, `actions/setup-node`, `actions/upload-artifact` and `actions/download-artifact`. Forks start with Actions disabled; the agent enables Actions on each fork after it has deleted every branch outside `ptg/`.

Nothing else is configured: the preview workflow holds no secrets, and pushes by the patchtogo GitHub App trigger workflows (only pushes made with a workflow's own `GITHUB_TOKEN` do not).

The pkg.pr.new comment on a patch pull request comes from the `pkg-pr-new[bot]` account. It is not a reviewer comment.
