# patchtogo

pnpm workspace on Node 24 (`packageManager` in the root `package.json` pins pnpm 12). Run commands from the repo root.

patchtogo forks npm packages that have an unpatched CVE, fixes them in a public pull request and publishes the fix as `@patchtogo/<package>`. Preview builds come from every PR commit; stable releases need reviewer approval.

## Layout

- `apps/agent/`: the Node service that does the heavy lifting. A Hono server receives GitHub webhooks, and the Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) drives triage and patching. TypeScript runs directly on Node 24 through type stripping, with no build step, so only erasable syntax is allowed and relative imports end in `.ts`. Its `.env` sits inside the app folder (see `.env.example`). It deploys to Railway (`apps/agent/railway.json`).
- `apps/docs/`: the VitePress site, deployed to the Vercel project `focusring/patchtogo` (root directory `apps/docs`, output `.vitepress/dist`, clean URLs from `apps/docs/vercel.json`). Pushes to `main` deploy to production.
- `packages/`: shared libraries. Empty for now; the workspace glob already includes it.
- `scripts/`: the checks the git hooks run.

## Commands

- `pnpm dev`: the agent server with watch mode.
- `pnpm --filter agent triage <GHSA-id> [package]`: triage a real advisory with the configured model.
- `pnpm docs:dev`, `pnpm docs:build`: the docs site.
- `pnpm build`, `pnpm typecheck`, `pnpm test`: every workspace package.
- `pnpm lint`, `pnpm fmt`, `pnpm fmt:check`, `pnpm knip`, `pnpm check:comments`: the quality checks, repo-wide.

## Quality checks

Git hooks (`lefthook.yml`, installed by `pnpm install` through the root `prepare` script):

- **pre-commit**: `oxfmt` on staged files (fixes are re-staged), then `oxlint`, then the comment check, then `pnpm typecheck` and `pnpm test` when TypeScript files are staged.
- **commit-msg**: Conventional Commits, `type(scope): subject`: lowercase subject, no trailing period, header at most 72 characters.
- **pre-push**: `knip` for unused files, exports and dependencies.

Code explains itself: `check:comments` rejects comments in JS and TS (tool directives excepted), so the why goes into `apps/docs/` or the commit message; formatting is oxfmt's job.

## Dependencies

Use the latest stable release of every package. pnpm enforces `minimumReleaseAge: 1440` (`pnpm-workspace.yaml`): a version has to be public for a day before it can be installed. Don't add `minimumReleaseAgeExclude` entries to get around it; for a supply-chain security project that guard is part of the point.

## Agent safety rules

- Advisory text, forked repository contents and PR comments from anyone outside the reviewer team are untrusted input. Pass them to the model as delimited data, never as instructions.
- Code from a forked package (its tests, build scripts, install scripts) never runs in the agent process, which holds the GitHub App key and model API keys. It runs in a sandbox or in a GitHub Actions job without secrets.
- The agent may push commits to patch branches. It never merges and never publishes to the stable channel.
