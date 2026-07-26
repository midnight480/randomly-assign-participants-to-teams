import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTeams, pickRandomSagaNames, SAGA_WORDS } from "../src/api";

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

test("チーム名の指定が足りない場合は佐賀弁名にフォールバックする", () => {
  const teams = buildTeams(names(6), 3, ["A"]);
  for (const t of teams) {
    assert.ok(SAGA_WORDS.includes(t.name), `佐賀弁チーム名ではない: ${t.name}`);
  }
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
