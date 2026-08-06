#!/usr/bin/env bash
# ローカルで画面を確認するための開発サーバ。
#   ./scripts/dev.sh
# DynamoDB Local を Docker で起動し、サンプルデータを入れてサーバを立てる。
# 本番デプロイには関係しない。
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER=team-drawer-ddb-dev
DDB_PORT=8001
PORT="${PORT:-3000}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! docker info >/dev/null 2>&1; then
  echo "Docker が必要です（DynamoDB Local を使うため）" >&2
  exit 1
fi

echo "==> TypeScript コンパイル"
npx tsc -p tsconfig.test.json

echo "==> DynamoDB Local を起動 (port $DDB_PORT)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p "$DDB_PORT:8000" amazon/dynamodb-local:latest >/dev/null
for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://localhost:$DDB_PORT/" && break
  sleep 0.5
done

export DYNAMODB_ENDPOINT="http://localhost:$DDB_PORT"
export TABLE_NAME=team-drawer-dev
export AWS_REGION=ap-northeast-1
export AWS_ACCESS_KEY_ID=dummy
export AWS_SECRET_ACCESS_KEY=dummy
export STATIC_DIR="$PWD/public"
# 本番と同じく EVENT_CODE / EVENT_TITLE で切り替えられる
export EVENT_CODE="${EVENT_CODE:-JAWS-SAGA}"
export EVENT_TITLE="${EVENT_TITLE:-JAWS-UG佐賀 チーム割り当て}"
export PORT
# USER_POOL_ID / USER_POOL_CLIENT_ID は未設定のまま。
# 管理者操作は 401 になる（認証の fail closed をローカルでも崩さない）。

echo "==> テーブル作成 & サンプルデータ投入"
node -e "
const { createTestTable } = require('./dist-test/test/helpers/table.js');
createTestTable().then(() => console.log('table ready'));
"
node dist-test/scripts/seed-local.js

echo "==> 開発サーバ起動"
node dist-test/scripts/dev-server.js
