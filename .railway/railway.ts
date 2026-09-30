import { defineRailway, postgres, preserve, project, service } from 'railway/iac'

const region = 'europe-west4-drams3a'

export default defineRailway(() => {
  const database = postgres('Postgres', { region })

  const agent = service('agent', {
    build: {
      builder: 'RAILPACK',
      buildCommand: 'pnpm --filter agent run --if-present build',
      watchPatterns: [
        '/apps/agent/**',
        '/packages/fixer-runner/**',
        '/package.json',
        '/pnpm-lock.yaml',
        '/pnpm-workspace.yaml',
        '/.railway/**'
      ]
    },
    start: 'pnpm --filter agent start',
    healthcheck: '/health',
    healthcheckTimeout: 120,
    replicas: { [region]: 1 },
    deploy: {
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      drainingSeconds: 30
    },
    env: {
      RAILPACK_NODE_VERSION: '24',
      DATABASE_URL: database.env.DATABASE_URL,
      ANTHROPIC_API_KEY: preserve(),
      ANTHROPIC_WORKSPACE_ID: preserve(),
      GITHUB_WEBHOOK_SECRET: preserve(),
      PTG_RUN_TOKEN_SECRET: preserve(),
      PTG_MODEL: preserve(),
      GITHUB_APP_ID: preserve(),
      GITHUB_APP_INSTALLATION_ID: preserve(),
      GITHUB_APP_PRIVATE_KEY: preserve(),
      GITHUB_TOKEN: preserve(),
      DISCORD_WEBHOOK_URL: preserve(),
      PTG_UPSTREAM_TOKEN: preserve(),
      VERCEL_TOKEN: preserve(),
      VERCEL_TEAM_ID: preserve(),
      VERCEL_PROJECT_ID: preserve(),
      PTG_MAX_CONCURRENT_RUNS: '2',
      PTG_WEBHOOK_MAX_MB: '25',
      PTG_MODEL_PROXY_MAX_MB: '32',
      PTG_FORK_ORG: 'patchtogo-ai',
      PTG_NPM_SCOPE: 'patchtogo.ai',
      PTG_REVIEWER_TEAM: 'reviewers',
      PTG_REQUIRED_APPROVALS: '1',
      PTG_AUTOMATION: 'full',
      PTG_AUTOMATION_PACKAGES: 'escape-html,decompress',
      PTG_MODEL_PROXY_URL: 'https://agent.patchtogo.ai/model-proxy',
      PORT: preserve(),
      GITHUB_APP_PRIVATE_KEY_PATH: preserve(),
      PTG_POLL_INTERVAL_MINUTES: preserve(),
      PTG_POLL_LOOKBACK_HOURS: preserve(),
      PTG_JOB_TIMEOUT_MINUTES: preserve(),
      PTG_MODEL_SMALL: preserve(),
      PTG_MODEL_INVESTIGATOR: preserve(),
      PTG_MODEL_EXPLOIT_TEST_WRITER: preserve(),
      PTG_MODEL_PATCH_WRITER: preserve(),
      PTG_MODEL_VERIFIER: preserve(),
      PTG_MODEL_DIFF_REVIEWER: preserve(),
      PTG_FIXER_MAX_TURNS: preserve(),
      PTG_FIXER_MAX_BUDGET_USD: preserve(),
      PTG_FIXER_TEST_TIMEOUT_MINUTES: preserve(),
      PTG_FIXER_TIMEOUT_MINUTES: preserve()
    }
  })

  return project('patchtogo', { resources: [agent, database] })
})
