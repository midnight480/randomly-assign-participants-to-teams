/**
 * EVENT_CODE / EVENT_TITLE がデプロイ時に差し替えられることを検証する。
 *
 * handler と db はモジュール読み込み時に環境変数を読むため、import より前に
 * process.env を設定する必要がある。node --test はテストファイルごとに
 * 別プロセスで動くので、ここで書き換えても他のテストには影響しない。
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

process.env.EVENT_CODE = "JBUG-SAGA";
process.env.EVENT_TITLE = "JBUG佐賀 チーム割り当て";

// import 文だとコンパイル後に上の process.env 設定より前へ持ち上がるため、
// ここだけ require で読み込む。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createTestTable, resetTestTable } = require("./helpers/table");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require("../src/handler");

before(createTestTable);
beforeEach(resetTestTable);

function req(
  method: string,
  rawPath: string,
  opts: { body?: unknown } = {}
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: "",
    headers: {},
    requestContext: {
      http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "1.2.3.4", userAgent: "test" },
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function parse(body: string | undefined) {
  return JSON.parse(body || "{}");
}

test("/api/config が EVENT_CODE と EVENT_TITLE を返す", async () => {
  const body = parse((await handler(req("GET", "/api/config"))).body);
  assert.equal(body.eventCode, "JBUG-SAGA");
  assert.equal(body.title, "JBUG佐賀 チーム割り当て");
});

test("差し替えたイベントコードで読み書きできる", async () => {
  const draw = await handler(
    req("POST", "/api/events/JBUG-SAGA/draw", { body: { display_name: "山田" } })
  );
  assert.equal(draw.statusCode, 200);

  const get = await handler(req("GET", "/api/events/JBUG-SAGA"));
  assert.equal(get.statusCode, 200);
  const body = parse(get.body);
  assert.equal(body.event_code, "JBUG-SAGA");
  assert.equal(body.title, "JBUG佐賀 チーム割り当て");
  assert.deepEqual(body.participants, ["山田"]);
});

test("差し替え前のコード（JAWS-SAGA）は 404 になる", async () => {
  for (const path of [
    "/api/events/JAWS-SAGA",
    "/api/events/JAWS-SAGA/draw",
  ]) {
    const res = await handler(req("GET", path));
    assert.equal(res.statusCode, 404, path);
  }
});

test("画面には JAWS-UG 固定のイベント名が残っていない", async () => {
  const js = await handler(req("GET", "/app.js"));
  assert.doesNotMatch(String(js.body), /JAWS-UG佐賀/, "app.js にイベント名が直書きされている");
  assert.doesNotMatch(String(js.body), /"JAWS-SAGA"/, "app.js にイベントコードが直書きされている");
});
