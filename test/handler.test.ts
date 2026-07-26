import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createTestTable, resetTestTable } from "./helpers/table";
import { handler } from "../src/handler";

before(createTestTable);
beforeEach(resetTestTable);

function req(
  method: string,
  rawPath: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {}
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: "",
    headers: opts.headers || {},
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

// --- 静的ファイル配信 -------------------------------------------------

test("ルートで index.html を返す", async () => {
  const res = await handler(req("GET", "/"));
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers?.["Content-Type"]), /text\/html/);
  assert.match(String(res.body), /<div id="app">/);
});

test("/app.js と /styles.css が正しい Content-Type で返る", async () => {
  const js = await handler(req("GET", "/app.js"));
  assert.equal(js.statusCode, 200);
  assert.match(String(js.headers?.["Content-Type"]), /javascript/);
  assert.match(String(js.body), /setupAppSyncRealtime/);

  const css = await handler(req("GET", "/styles.css"));
  assert.equal(css.statusCode, 200);
  assert.match(String(css.headers?.["Content-Type"]), /text\/css/);
});

test("/e/* は SPA ルーティングとして index.html を返す", async () => {
  for (const p of ["/e/JAWS-SAGA", "/e/JAWS-SAGA/admin"]) {
    const res = await handler(req("GET", p));
    assert.equal(res.statusCode, 200, p);
    assert.match(String(res.headers?.["Content-Type"]), /text\/html/, p);
  }
});

test("index.html はキャッシュされない（デプロイ直後に古い画面が出ない）", async () => {
  const res = await handler(req("GET", "/"));
  assert.equal(res.headers?.["Cache-Control"], "no-store");
});

test("パストラバーサルで public の外を読めない", async () => {
  for (const p of [
    "/../package.json",
    "/../../etc/passwd",
    "/%2e%2e/package.json",
    "/....//package.json",
  ]) {
    const res = await handler(req("GET", p));
    // index.html にフォールバックするか 404。いずれにせよ中身が漏れないこと
    assert.doesNotMatch(String(res.body), /"devDependencies"/, `漏洩: ${p}`);
    assert.doesNotMatch(String(res.body), /root:x:/, `漏洩: ${p}`);
  }
});

// --- API ルーティング -------------------------------------------------

test("GET /api/config が設定値を返す", async () => {
  const res = await handler(req("GET", "/api/config"));
  assert.equal(res.statusCode, 200);
  const body = parse(res.body);
  for (const key of [
    "userPoolId",
    "userPoolClientId",
    "appsyncHttpEndpoint",
    "appsyncRealtimeEndpoint",
    "appsyncApiKey",
    "appsyncChannel",
  ]) {
    assert.ok(key in body, `${key} が無い`);
  }
});

test("未定義の API パスは 404 JSON を返す", async () => {
  const res = await handler(req("GET", "/api/does-not-exist"));
  assert.equal(res.statusCode, 404);
  assert.ok(parse(res.body).error);
});

test("GET /api/events/{code} が初期状態を返す", async () => {
  const res = await handler(req("GET", "/api/events/JAWS-SAGA"));
  assert.equal(res.statusCode, 200);
  const body = parse(res.body);
  assert.equal(body.event_code, "JAWS-SAGA");
  assert.deepEqual(body.teams, []);
  assert.equal(body.assigned_count, 0);
});

test("参加者を登録して読み出せる", async () => {
  const post = await handler(
    req("POST", "/api/events/JAWS-SAGA/participants", {
      body: { names: ["山田太郎", "佐藤花子"] },
    })
  );
  assert.equal(post.statusCode, 200);
  assert.deepEqual(parse(post.body).added, ["山田太郎", "佐藤花子"]);

  const get = await handler(req("GET", "/api/events/JAWS-SAGA"));
  assert.deepEqual(parse(get.body).participants, ["山田太郎", "佐藤花子"]);
});

test("同じ参加者名は重複登録されない", async () => {
  await handler(
    req("POST", "/api/events/JAWS-SAGA/participants", { body: { names: ["山田"] } })
  );
  const second = await handler(
    req("POST", "/api/events/JAWS-SAGA/participants", { body: { names: ["山田", "佐藤"] } })
  );
  assert.deepEqual(parse(second.body).added, ["佐藤"]);

  const get = await handler(req("GET", "/api/events/JAWS-SAGA"));
  assert.deepEqual(parse(get.body).participants, ["山田", "佐藤"]);
});

test("参加者数の上限を超える登録は全件拒否される", async () => {
  const many = Array.from({ length: 600 }, (_, i) => `参加者${i}`);
  const res = await handler(
    req("POST", "/api/events/JAWS-SAGA/participants", { body: { names: many } })
  );
  assert.equal(res.statusCode, 400);
  assert.match(parse(res.body).error, /上限/);

  // 中途半端に保存されていないこと
  const get = await handler(req("GET", "/api/events/JAWS-SAGA"));
  assert.equal(parse(get.body).participant_count, 0);
});

test("上限ちょうどまでは登録できる", async () => {
  const exact = Array.from({ length: 500 }, (_, i) => `参加者${i}`);
  const ok = await handler(
    req("POST", "/api/events/JAWS-SAGA/participants", { body: { names: exact } })
  );
  assert.equal(ok.statusCode, 200);
  assert.equal(parse((await handler(req("GET", "/api/events/JAWS-SAGA"))).body).participant_count, 500);

  // その先の1名は拒否される
  const over = await handler(
    req("POST", "/api/events/JAWS-SAGA/participants", { body: { names: ["あと一人"] } })
  );
  assert.equal(over.statusCode, 400);
});

test("許可されていないイベントコードへの書き込みは 404（無制限にイベントを作れない）", async () => {
  for (const code of ["ATTACKER-1", "foo", "JAWS-SAGA2"]) {
    const res = await handler(
      req("POST", `/api/events/${code}/participants`, { body: { names: ["x"] } })
    );
    assert.equal(res.statusCode, 404, `作成できてしまった: ${code}`);
  }

  // 正規のコードは通り、大文字小文字は正規化される
  for (const code of ["JAWS-SAGA", "jaws-saga"]) {
    const res = await handler(
      req("POST", `/api/events/${code}/participants`, { body: { names: ["山田"] } })
    );
    assert.equal(res.statusCode, 200, `拒否されてしまった: ${code}`);
  }
});

test("許可されていないイベントコードの参照も 404", async () => {
  const res = await handler(req("GET", "/api/events/ATTACKER-1"));
  assert.equal(res.statusCode, 404);
});

test("参加者名が空なら 400", async () => {
  const res = await handler(
    req("POST", "/api/events/JAWS-SAGA/participants", { body: { names: [] } })
  );
  assert.equal(res.statusCode, 400);
});

// --- 認証ゲート -------------------------------------------------------
// テスト環境では USER_POOL_ID / USER_POOL_CLIENT_ID が未設定なので
// verifyAdminToken は必ず false を返す（fail closed）。

test("認証ヘッダ無しのシャッフルは 401", async () => {
  const res = await handler(
    req("POST", "/api/events/JAWS-SAGA/admin/shuffle", {
      body: { participant_names: ["山田", "佐藤"], team_count: 2 },
    })
  );
  assert.equal(res.statusCode, 401);
});

test("でたらめなトークンでもシャッフルは通らない（fail closed）", async () => {
  for (const token of ["Bearer aaaa", "aaaa", "Bearer ", "null", "undefined"]) {
    const res = await handler(
      req("POST", "/api/events/JAWS-SAGA/admin/shuffle", {
        body: { participant_names: ["山田"], team_count: 1 },
        headers: { authorization: token },
      })
    );
    assert.equal(res.statusCode, 401, `通過してしまった: ${token}`);
  }
});

test("認証無しのリセットは 401 で、状態を壊さない", async () => {
  await handler(
    req("POST", "/api/events/JAWS-SAGA/participants", { body: { names: ["山田"] } })
  );
  const res = await handler(req("POST", "/api/events/JAWS-SAGA/admin/reset"));
  assert.equal(res.statusCode, 401);

  const get = await handler(req("GET", "/api/events/JAWS-SAGA"));
  assert.deepEqual(parse(get.body).participants, ["山田"]);
});

test("壊れた JSON ボディでも 500 で落ちずに応答する", async () => {
  const ev = req("POST", "/api/events/JAWS-SAGA/participants");
  (ev as any).body = "{not json";
  const res = await handler(ev);
  assert.equal(res.statusCode, 500);
  assert.ok(parse(res.body).error);
});

test("base64 エンコードされたボディを復号して扱える", async () => {
  const ev = req("POST", "/api/events/JAWS-SAGA/participants");
  (ev as any).body = Buffer.from(JSON.stringify({ names: ["山田"] })).toString("base64");
  (ev as any).isBase64Encoded = true;
  const res = await handler(ev);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parse(res.body).added, ["山田"]);
});

test("会場表示モード /e/{code}/display も index.html を返す", async () => {
  const res = await handler(req("GET", "/e/JAWS-SAGA/display"));
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers?.["Content-Type"]), /text\/html/);
});

test("参加者が1名ずつ自己登録できる（QR経由の参加フロー）", async () => {
  for (const name of ["しばお", "佐賀太郎"]) {
    const res = await handler(
      req("POST", "/api/events/JAWS-SAGA/participants", { body: { names: [name] } })
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(parse(res.body).added, [name]);
  }

  const get = await handler(req("GET", "/api/events/JAWS-SAGA"));
  const body = parse(get.body);
  assert.deepEqual(body.participants, ["しばお", "佐賀太郎"]);
  assert.equal(body.participant_count, 2);
});

test("同じ人が二度登録しても重複しない（連打・再読み込み対策）", async () => {
  await handler(req("POST", "/api/events/JAWS-SAGA/participants", { body: { names: ["しばお"] } }));
  const second = await handler(
    req("POST", "/api/events/JAWS-SAGA/participants", { body: { names: ["しばお"] } })
  );
  assert.equal(second.statusCode, 200);
  assert.deepEqual(parse(second.body).added, []);

  const get = await handler(req("GET", "/api/events/JAWS-SAGA"));
  assert.equal(parse(get.body).participant_count, 1);
});

// --- くじ引き（参加者セルフ抽選） ----------------------------------------

test("くじを引くとその場でチームが決まる（管理者操作不要）", async () => {
  const res = await handler(
    req("POST", "/api/events/JAWS-SAGA/draw", { body: { display_name: "しばお" } })
  );
  assert.equal(res.statusCode, 200);
  const d = parse(res.body);
  assert.equal(d.display_name, "しばお");
  assert.ok(d.team_name, "チーム名が返っていない");
  assert.equal(d.already_assigned, false);

  const get = await handler(req("GET", "/api/events/JAWS-SAGA"));
  const body = parse(get.body);
  const team = body.teams.find((t: any) => t.members.includes("しばお"));
  assert.ok(team, "チームに入っていない");
  assert.equal(team.name, d.team_name);
});

test("同じ人が二度引いても同じチームが返る（連打・再読み込み対策）", async () => {
  const first = parse(
    (await handler(req("POST", "/api/events/JAWS-SAGA/draw", { body: { display_name: "しばお" } }))).body
  );
  const second = parse(
    (await handler(req("POST", "/api/events/JAWS-SAGA/draw", { body: { display_name: "しばお" } }))).body
  );
  assert.equal(second.team_name, first.team_name);
  assert.equal(second.already_assigned, true);

  const get = await handler(req("GET", "/api/events/JAWS-SAGA"));
  assert.equal(parse(get.body).participant_count, 1);
});

test("表示名が空ならくじを引けない", async () => {
  for (const name of ["", "   "]) {
    const res = await handler(
      req("POST", "/api/events/JAWS-SAGA/draw", { body: { display_name: name } })
    );
    assert.equal(res.statusCode, 400);
  }
});

test("人数が増えてもチームは均等に保たれる（枠切れで参加できなくならない）", async () => {
  for (let i = 0; i < 23; i++) {
    const res = await handler(
      req("POST", "/api/events/JAWS-SAGA/draw", { body: { display_name: `参加者${i}` } })
    );
    assert.equal(res.statusCode, 200, `${i}人目で失敗`);
  }

  const body = parse((await handler(req("GET", "/api/events/JAWS-SAGA"))).body);
  const sizes = body.teams.map((t: any) => t.members.length);
  assert.equal(body.participant_count, 23);
  assert.equal(sizes.reduce((a: number, b: number) => a + b, 0), 23);
  assert.ok(
    Math.max(...sizes) - Math.min(...sizes) <= 1,
    `人数が偏っている: ${JSON.stringify(sizes)}`
  );
});

test("同時に引いても誰も取りこぼされない（楽観ロック）", async () => {
  const names = Array.from({ length: 20 }, (_, i) => `同時${i}`);
  const results = await Promise.all(
    names.map((n) =>
      handler(req("POST", "/api/events/JAWS-SAGA/draw", { body: { display_name: n } }))
    )
  );
  for (const r of results) assert.equal(r.statusCode, 200);

  const body = parse((await handler(req("GET", "/api/events/JAWS-SAGA"))).body);
  assert.equal(body.participant_count, 20, "参加者が取りこぼされた");

  const assigned = body.teams.flatMap((t: any) => t.members);
  assert.equal(assigned.length, 20, "チームへの割り当てが取りこぼされた");
  assert.deepEqual([...assigned].sort(), [...names].sort());
});
