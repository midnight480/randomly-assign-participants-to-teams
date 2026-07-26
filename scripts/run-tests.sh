#!/usr/bin/env bash
# ローカルテスト実行。DynamoDB Local を Docker で起動して統合テストまで回す。
#   ./scripts/run-tests.sh
# Docker が無い場合は純粋ロジックの単体テストだけ実行する。
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER=team-drawer-ddb-test
PORT=8000

cleanup() {
  if [ "${STARTED_DDB:-0}" = "1" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "==> TypeScript コンパイル"
npx tsc -p tsconfig.test.json

if docker info >/dev/null 2>&1; then
  echo "==> DynamoDB Local を起動 (port $PORT)"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" -p "$PORT:8000" amazon/dynamodb-local:latest >/dev/null
  STARTED_DDB=1

  # 起動待ち
  for _ in $(seq 1 30); do
    if curl -s -o /dev/null "http://localhost:$PORT/"; then break; fi
    sleep 0.5
  done

  export DYNAMODB_ENDPOINT="http://localhost:$PORT"
  TEST_GLOB="dist-test/test/*.test.js"
else
  echo "==> Docker が使えないため単体テストのみ実行します"
  TEST_GLOB="dist-test/test/build-teams.test.js"
fi

export TABLE_NAME=team-drawer-test
export AWS_REGION=ap-northeast-1
export AWS_ACCESS_KEY_ID=dummy
export AWS_SECRET_ACCESS_KEY=dummy
export STATIC_DIR="$PWD/public"
# USER_POOL_ID / USER_POOL_CLIENT_ID は意図的に未設定
# （認証が fail closed になることを検証するため）

# テストファイル間で DynamoDB Local の同じテーブルを共有するため、
# 並列実行すると beforeEach のテーブル作り直しが他ファイルと干渉する。
# 直列実行に固定する（全体で 1 秒未満なので実害なし）。
echo "==> テスト実行"
node --test --test-concurrency=1 "$TEST_GLOB"
