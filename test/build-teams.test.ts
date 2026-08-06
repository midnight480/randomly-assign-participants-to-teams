import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyTeamConfig,
  buildTeams,
  pickRandomSagaNames,
  resolveTeamNames,
  withoutParticipants,
  SAGA_WORDS,
} from "../src/api";

function names(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `参加者${i + 1}`);
}

test("全員がちょうど1回だけ割り当てられる（欠落・重複なし）", () => {
  for (const participantCount of [1, 2, 5, 6, 7, 13, 40]) {
    for (const teamCount of [1, 2, 3, 4, 5]) {
      const input = names(participantCount);
      const teams = buildTeams(input, teamCount);
      const assigned = teams.flatMap((t) => t.members);

      assert.equal(
        assigned.length,
        participantCount,
        `${participantCount}名 / ${teamCount}チーム: 割り当て人数が一致しない`
      );
      assert.deepEqual(
        [...assigned].sort(),
        [...input].sort(),
        `${participantCount}名 / ${teamCount}チーム: メンバー集合が一致しない`
      );
    }
  }
});

test("チーム人数の差は最大1名（余りは先頭チームから配られる）", () => {
  const teams = buildTeams(names(7), 3);
  const sizes = teams.map((t) => t.members.length);
  assert.deepEqual(sizes, [3, 2, 2]);
  assert.equal(Math.max(...sizes) - Math.min(...sizes), 1);
});

test("size フィールドが実メンバー数と一致する", () => {
  for (const [p, c] of [[10, 3], [4, 4], [1, 3], [100, 7]] as const) {
    for (const t of buildTeams(names(p), c)) {
      assert.equal(t.size, t.members.length, `${p}名/${c}チーム: ${t.name}`);
    }
  }
});

test("参加者数よりチーム数が多い場合、空チームができるが例外にならない", () => {
  const teams = buildTeams(names(2), 5);
  assert.equal(teams.length, 5);
  assert.equal(teams.flatMap((t) => t.members).length, 2);
  assert.equal(teams.filter((t) => t.members.length === 0).length, 3);
});

test("teamCount が 0 以下でも最低1チームになる", () => {
  assert.equal(buildTeams(names(3), 0).length, 1);
  assert.equal(buildTeams(names(3), -5).length, 1);
});

test("チーム名を明示指定した場合はそれが使われる", () => {
  const teams = buildTeams(names(6), 3, ["A", "B", "C"]);
  assert.deepEqual(teams.map((t) => t.name), ["A", "B", "C"]);
});

test("チーム名の指定が足りない分だけ佐賀弁名で埋める（指定した名前は残る）", () => {
  const teams = buildTeams(names(6), 3, ["A"]);
  assert.equal(teams[0].name, "A");
  for (const t of teams.slice(1)) {
    assert.ok(SAGA_WORDS.includes(t.name), `佐賀弁チーム名ではない: ${t.name}`);
  }
});

// --- resolveTeamNames -------------------------------------------------

test("resolveTeamNames: 空欄は佐賀弁で埋め、指定名と重複しない", () => {
  const { names: resolved, error } = resolveTeamNames(["がばい", "", ""], 3);
  assert.equal(error, undefined);
  assert.equal(resolved[0], "がばい");
  assert.equal(new Set(resolved).size, 3);
});

test("resolveTeamNames: 重複した指定はエラーにする", () => {
  const { error } = resolveTeamNames(["A", "A"], 2);
  assert.ok(error, "重複が素通りした");
});

test("resolveTeamNames: 前後の空白を落とし、長すぎる名前は切り詰める", () => {
  const { names: resolved } = resolveTeamNames(["  ゆったり　チーム  ", "あ".repeat(40)], 2);
  assert.equal(resolved[0], "ゆったり チーム");
  assert.equal(resolved[1].length, 20);
});

test("resolveTeamNames: 空白だけの名前は未指定として扱う", () => {
  const { names: resolved, error } = resolveTeamNames(["　", " "], 2);
  assert.equal(error, undefined);
  assert.equal(new Set(resolved).size, 2);
  for (const n of resolved) assert.ok(n.trim().length > 0);
});

test("resolveTeamNames: 指定が count より多くても count 個に収める", () => {
  const { names: resolved } = resolveTeamNames(["A", "B", "C"], 2);
  assert.deepEqual(resolved, ["A", "B"]);
});

// --- applyTeamConfig --------------------------------------------------

function team(name: string, members: string[]) {
  return { name, size: members.length, members };
}

test("applyTeamConfig: 同数なら名前だけ変わりメンバーは動かない", () => {
  const before = [team("A", ["山田", "佐藤"]), team("B", ["田中"])];
  const after = applyTeamConfig(before, ["あか", "あお"]);

  assert.deepEqual(after.map((t) => t.name), ["あか", "あお"]);
  assert.deepEqual(after[0].members, ["山田", "佐藤"]);
  assert.deepEqual(after[1].members, ["田中"]);
});

test("applyTeamConfig: 増やしたチームは空で、既存メンバーは動かない", () => {
  const before = [team("A", ["山田", "佐藤"])];
  const after = applyTeamConfig(before, ["A", "B", "C"]);

  assert.equal(after.length, 3);
  assert.deepEqual(after[0].members, ["山田", "佐藤"]);
  assert.deepEqual(after[1].members, []);
  assert.deepEqual(after[2].members, []);
});

test("applyTeamConfig: 減らすとあふれたメンバーが少ないチームへ移る", () => {
  const before = [team("A", ["a1", "a2", "a3"]), team("B", ["b1"]), team("C", ["c1", "c2"])];
  const after = applyTeamConfig(before, ["A", "B"]);

  assert.equal(after.length, 2);
  const all = after.flatMap((t) => t.members);
  assert.deepEqual([...all].sort(), ["a1", "a2", "a3", "b1", "c1", "c2"].sort());
  // C の2名は人数の少ない B へ寄る
  assert.deepEqual(after[1].members, ["b1", "c1", "c2"]);
});

test("applyTeamConfig: size が実メンバー数と一致する", () => {
  const before = [team("A", ["a1"]), team("B", ["b1", "b2"])];
  for (const t of applyTeamConfig(before, ["X"])) {
    assert.equal(t.size, t.members.length);
  }
});

// --- withoutParticipants ----------------------------------------------

test("withoutParticipants: 指定した人だけチームと参加者リストから消える", () => {
  const teams = [team("A", ["山田", "佐藤"]), team("B", ["田中"])];
  const res = withoutParticipants(teams, ["山田", "佐藤", "田中"], ["佐藤"]);

  assert.deepEqual(res.participants, ["山田", "田中"]);
  assert.deepEqual(res.teams[0].members, ["山田"]);
  assert.deepEqual(res.teams[1].members, ["田中"]);
  assert.deepEqual(res.removed, ["佐藤"]);
  assert.deepEqual(res.notFound, []);
});

test("withoutParticipants: チーム名・チーム数・空チームは変わらない", () => {
  const teams = [team("A", ["山田"]), team("B", [])];
  const res = withoutParticipants(teams, ["山田"], ["山田"]);

  assert.deepEqual(res.teams.map((t) => t.name), ["A", "B"]);
  assert.equal(res.teams.length, 2);
  assert.deepEqual(res.teams[0].members, []);
});

test("withoutParticipants: size が実メンバー数に追従する", () => {
  const teams = [team("A", ["山田", "佐藤"])];
  const res = withoutParticipants(teams, ["山田", "佐藤"], ["山田"]);
  assert.equal(res.teams[0].size, 1);
  assert.equal(res.teams[0].size, res.teams[0].members.length);
});

test("withoutParticipants: 複数人をまとめて削除できる", () => {
  const teams = [team("A", ["a", "b"]), team("B", ["c", "d"])];
  const res = withoutParticipants(teams, ["a", "b", "c", "d"], ["b", "c"]);
  assert.deepEqual(res.participants, ["a", "d"]);
  assert.deepEqual(res.teams.flatMap((t) => t.members), ["a", "d"]);
  assert.deepEqual([...res.removed].sort(), ["b", "c"]);
});

test("withoutParticipants: 居ない名前は notFound で返り、状態は変わらない", () => {
  const teams = [team("A", ["山田"])];
  const res = withoutParticipants(teams, ["山田"], ["居ない人"]);

  assert.deepEqual(res.removed, []);
  assert.deepEqual(res.notFound, ["居ない人"]);
  assert.deepEqual(res.participants, ["山田"]);
  assert.deepEqual(res.teams[0].members, ["山田"]);
});

test("withoutParticipants: 参加者リストにだけ居る人も削除できる", () => {
  // くじを引かずに管理者が名前だけ登録した状態
  const res = withoutParticipants([team("A", [])], ["未参加の人"], ["未参加の人"]);
  assert.deepEqual(res.participants, []);
  assert.deepEqual(res.removed, ["未参加の人"]);
});

test("withoutParticipants: 前後の空白は無視して一致させる", () => {
  const res = withoutParticipants([team("A", ["山田 太郎"])], ["山田 太郎"], ["  山田　太郎  "]);
  assert.deepEqual(res.removed, ["山田 太郎"]);
  assert.deepEqual(res.participants, []);
});

test("applyTeamConfig: チームが無い状態からでも空チームを用意できる", () => {
  const after = applyTeamConfig([], ["あか", "あお", "きいろ"]);
  assert.deepEqual(after.map((t) => t.name), ["あか", "あお", "きいろ"]);
  assert.deepEqual(after.flatMap((t) => t.members), []);
});

test("佐賀弁チーム名は重複しない", () => {
  for (const n of [1, 5, 10, 30]) {
    const picked = pickRandomSagaNames(n);
    assert.equal(picked.length, n);
    assert.equal(new Set(picked).size, n, `${n}件で重複が発生`);
  }
});

test("佐賀弁の語彙数を超える場合は連番チーム名で埋める", () => {
  const picked = pickRandomSagaNames(SAGA_WORDS.length + 3);
  assert.equal(picked.length, SAGA_WORDS.length + 3);
  assert.equal(new Set(picked).size, picked.length);
  assert.ok(picked.some((n) => /^チーム\d+$/.test(n)));
});

test("シャッフルされている（同一入力で毎回同じ並びにならない）", () => {
  const input = names(20);
  const results = new Set(
    Array.from({ length: 30 }, () =>
      buildTeams(input, 4)
        .map((t) => t.members.join(","))
        .join("|")
    )
  );
  assert.ok(results.size > 1, "30回試行して並びが1通りしか出なかった");
});
