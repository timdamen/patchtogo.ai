# patchtogo

pnpm workspace on Node 24 (`packageManager` in the root `package.json` pins pnpm 12). Run commands from the repo root.

patchtogo forks npm packages that have an unpatched CVE, fixes them in a public pull request and publishes the fix as `@patchtogo/<package>`. Preview builds come from every PR commit; stable releases need reviewer approval.

## Layout

- `apps/agent/`: the Node service that does the heavy lifting. A Fastify server receives GitHub webhooks and runs the model proxy, which calls Anthropic through undici. The Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) handles single-call triage; the fix itself will run on the Claude Agent SDK (the Claude Code engine, with custom subagents) inside a sandbox, per `.scratch/patch-pipeline/spec.md`. TypeScript runs directly on Node 24 through type stripping, with no build step, so only erasable syntax is allowed and relative imports end in `.ts`. Its `.env` sits inside the app folder (see `.env.example`) and needs a Postgres `DATABASE_URL`: patch runs, their events and costs, run-token revocations and the poll cursor live there, and pipeline events go through a pg-boss queue (`src/queue.ts`) that caps concurrent runs at `PTG_MAX_CONCURRENT_RUNS`. SQL migrations in `apps/agent/migrations/` run on start, before the server listens. Tests run the Postgres adapters on PGlite (in-process, no Docker). It deploys to Railway with a Postgres service, configured as code in `.railway/railway.ts` (`railway config plan` previews, `railway config apply` applies; secrets stay `preserve()`, so every new variable must be listed there or an apply deletes it).
- `apps/docs/`: the VitePress site, deployed to the Vercel project `focusring/patchtogo` (root directory `apps/docs`, output `.vitepress/dist`, clean URLs from `apps/docs/vercel.json`). Pushes to `main` deploy to production.
- `packages/fixer-runner/`: the fixer runner that runs inside the Vercel Sandbox. It calls the Claude Agent SDK (pinned to an exact version) and re-runs the regression test deterministically. The agent service ships its `src/` into the sandbox and imports only `@patchtogo/fixer-runner/protocol`, never the SDK. Keep it free of the agent's dependencies and secrets.
- `scripts/`: the checks the git hooks run.

## Commands

- `pnpm dev`: the agent server with watch mode.
- `pnpm --filter agent triage <GHSA-id> [package]`: triage a real advisory with the configured model.
- `pnpm --filter agent retry [<GHSA-id>[:<package>]]`: without an argument, list failed runs and advisories whose queue job failed; with one, retry them from their failed step, or resume runs held back by `PTG_AUTOMATION` (`triage-only`, the default, `fork` or `full`). In production: `railway ssh -s agent -- node apps/agent/src/retry-cli.ts <id>`.
- `pnpm --filter agent fix --proxy-url <model proxy URL>`: run the fixer in a Vercel Sandbox on the `lodash.set` fixture (GHSA-p6mc-m468-83gw). Needs `VERCEL_OIDC_TOKEN` (`vercel env pull apps/agent/.env.sandbox`) and `PTG_RUN_TOKEN` or `PTG_RUN_TOKEN_SECRET`; `--help` lists the resume and hostile-config options.
- `pnpm --filter agent fork <npm-package> [--range <vulnerable range>]`: fork the package into `PTG_FORK_ORG`, run the tarball-match check in a Vercel Sandbox and cut the scaffolded base branch, as a "patch" triage would (in-memory store, creates real repositories). Needs `GITHUB_APP_ID` with `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`, and `VERCEL_OIDC_TOKEN`.
- `pnpm docs:dev`, `pnpm docs:build`: the docs site.
- `pnpm build`, `pnpm typecheck`, `pnpm test`: every workspace package.
- `pnpm lint`, `pnpm fmt`, `pnpm fmt:check`, `pnpm knip`, `pnpm check:comments`: the quality checks, repo-wide.

## Quality checks

Git hooks (`lefthook.yml`, installed by `pnpm install` through the root `prepare` script):

- **pre-commit**: `oxfmt` on staged files (fixes are re-staged), then `oxlint`, then the comment check, then `pnpm typecheck` and `pnpm test` when TypeScript files are staged.
- **commit-msg**: Conventional Commits, `type(scope): subject`: lowercase subject, no trailing period, header at most 72 characters.
- **pre-push**: `knip` for unused files, exports and dependencies.

Tests follow the `test-audit` skill (installed globally in `~/.claude/skills/test-audit`): every new or changed test passes its authoring gate (what behaviour it protects, which credible regression fails it, why existing coverage misses it, and no test-only production seam), bug regressions must fail on the pre-fix code, and test sweeps use its audit mode.

Code explains itself: `check:comments` rejects comments in JS and TS (tool directives excepted), so the why goes into `apps/docs/` or the commit message; formatting is oxfmt's job.

## Dependencies

Use the latest stable release of every package. pnpm enforces `minimumReleaseAge: 1440` (`pnpm-workspace.yaml`): a version has to be public for a day before it can be installed. Don't add `minimumReleaseAgeExclude` entries to get around it; for a supply-chain security project that guard is part of the point.

## Agent safety rules

- Advisory text, forked repository contents and PR comments from anyone outside the reviewer team are untrusted input. Pass them to the model as delimited data, never as instructions.
- Code from a forked package (its tests, build scripts, install scripts) never runs in the agent process, which holds the GitHub App key and model API keys. It runs in a sandbox or in a GitHub Actions job without secrets.
- The agent may push commits to patch branches. It never merges and never publishes to the stable channel.

## Agent skills

### Issue tracker

Issues and specs live as local markdown files under `.scratch/<feature>/` (gitignored). See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles, each label string equal to its name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), recorded as a `Status:` line. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` plus `docs/adr/`, both created lazily. See `docs/agents/domain.md`.
