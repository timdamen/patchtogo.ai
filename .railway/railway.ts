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
      VERCEL_TOKEN: preserve(),
      VERCEL_TEAM_ID: preserve(),
      VERCEL_PROJECT_ID: preserve(),
      PTG_MAX_CONCURRENT_RUNS: '2',
      PTG_FORK_ORG: 'patchtogo-ai',
      PTG_NPM_SCOPE: 'patchtogo.ai',
      PTG_REVIEWER_TEAM: 'reviewers',
      PTG_MODEL_PROXY_URL: 'https://agent.patchtogo.ai/model-proxy'
    }
  })

  return project('patchtogo', { resources: [agent, database] })
})
