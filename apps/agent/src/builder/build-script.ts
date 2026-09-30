export const buildEnv = {
  CI: 'true',
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  COREPACK_ENABLE_STRICT: '0',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false'
}

export const buildScript = `set -euo pipefail
package_dir="$1"; pack_dir="$2"; before="$3"
if [ -f pnpm-lock.yaml ]; then
  corepack pnpm install --no-frozen-lockfile
  cd "$package_dir"
  corepack pnpm run --if-present build
  corepack pnpm pack --pack-destination "$pack_dir"
else
  if [ -f yarn.lock ]; then
    corepack yarn install
  elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ] || [ -z "$before" ]; then
    npm install
  else
    npm install --before="$before"
  fi
  cd "$package_dir"
  npm run build --if-present
  npm pack --pack-destination "$pack_dir"
fi`
