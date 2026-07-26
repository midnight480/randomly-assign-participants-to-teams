import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestTable, resetTestTable } from "./helpers/table";
import { getEventState, saveEventState, setParticipants } from "../src/db";

before(createTestTable);
beforeEach(resetTestTable);

test("未作成のイベントは空の状態を返す（書き込みはしない）", async () => {
  const state = await getEventState("JAWS-SAGA");
  assert.equal(state.eventCode, "JAWS-SAGA");
  assert.deepEqual(state.teams, []);
  assert.deepEqual(state.participants, []);
  assert.deepEqual(state.comments, {});
});

test("イベントコードは大文字に正規化される", async () => {
  await setParticipants("jaws-saga", ["山田"]);
  const state = await getEventState("  JaWs-SaGa  ");
  assert.deepEqual(state.participants, ["山田"]);
});

test("保存した状態が別の呼び出しから読める（コンテナ跨ぎの再現）", async () => {
  const teams = [
    { name: "がばい", size: 2, members: ["山田", "佐藤"] },
    { name: "そいぎ", size: 1, members: ["鈴木"] },
  ];
  await saveEventState("JAWS-SAGA", {
    teams,
    comments: { がばい: "よかね", そいぎ: "そいぎ！" },
    participants: ["山田", "佐藤", "鈴木"],
    pattern: { teams: teams.map((t) => ({ name: t.name, size: t.size })) },
  });

  const state = await getEventState("JAWS-SAGA");
  assert.deepEqual(state.teams, teams);
  assert.equal(state.comments["がばい"], "よかね");
  assert.deepEqual(state.participants, ["山田", "佐藤", "鈴木"]);
  assert.equal(state.pattern.teams.length, 2);
});

test("部分更新は他のフィールドを消さない", async () => {
  await saveEventState("JAWS-SAGA", { participants: ["山田", "佐藤"] });
  await saveEventState("JAWS-SAGA", {
    teams: [{ name: "がばい", size: 2, members: ["山田", "佐藤"] }],
  });

  const state = await getEventState("JAWS-SAGA");
  assert.deepEqual(state.participants, ["山田", "佐藤"], "participants が消えた");
  assert.equal(state.teams.length, 1);
});

test("updatedAt が保存のたびに更新される", async () => {
  const first = await saveEventState("JAWS-SAGA", { participants: ["山田"] });
  await new Promise((r) => setTimeout(r, 10));
  const second = await saveEventState("JAWS-SAGA", { participants: ["山田", "佐藤"] });
  assert.ok(
    new Date(second.updatedAt) > new Date(first.updatedAt),
    "updatedAt が進んでいない"
  );
});

test("日本語・記号を含む名前が壊れずに往復する", async () => {
  const tricky = ["山田 太郎", "O'Brien", "<script>", "絵文字🎲", "田中　花子"];
  await setParticipants("JAWS-SAGA", tricky);
  const state = await getEventState("JAWS-SAGA");
  assert.deepEqual(state.participants, tricky);
});

test("イベントコードが異なれば状態は混ざらない", async () => {
  await setParticipants("EVENT-A", ["山田"]);
  await setParticipants("EVENT-B", ["佐藤"]);
  assert.deepEqual((await getEventState("EVENT-A")).participants, ["山田"]);
  assert.deepEqual((await getEventState("EVENT-B")).participants, ["佐藤"]);
});
