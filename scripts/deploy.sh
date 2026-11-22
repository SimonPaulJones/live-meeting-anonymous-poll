#!/bin/sh
# Copies public/ to a web server over SSH. Settings come from scripts/deploy.env (copy deploy.env.example).
# The server's poll data (data/rooms/, data/secret.php, data/lock) is never overwritten.
set -e
cd "$(dirname "$0")/.."
[ -f scripts/deploy.env ] || { echo "Copy scripts/deploy.env.example to scripts/deploy.env first." >&2; exit 1; }
. scripts/deploy.env
[ -f public/config.php ] || { echo "Copy public/config.example.php to public/config.php first." >&2; exit 1; }
if [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted changes: commit them first." >&2
  exit 1
fi

# check the API parses with the server's own PHP before it goes live
ssh "$DEPLOY_SSH" "php -l" < public/api.php
ssh "$DEPLOY_SSH" "mkdir -p '$DEPLOY_PATH/data'"
rsync -rlt --delete --exclude .DS_Store \
  --exclude 'data/state.json*' --exclude data/rooms --exclude data/secret.php --exclude 'data/config.php*' --exclude data/lock \
  public/ "$DEPLOY_SSH:$DEPLOY_PATH/"
if [ -n "$DEPLOY_OWNER" ]; then
  ssh "$DEPLOY_SSH" "chown -R '$DEPLOY_OWNER' '$DEPLOY_PATH'"
fi
ssh "$DEPLOY_SSH" "cd '$DEPLOY_PATH' && find . -type d -exec chmod 755 {} + && find . -type f ! -path './data/*' -exec chmod 644 {} + && chmod 644 data/.htaccess"
echo "Deployed $(git rev-parse --short HEAD) to $DEPLOY_URL"
