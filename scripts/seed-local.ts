/**
 * ローカルの DynamoDB Local に、画面確認用のチーム分け結果を入れる。
 * 管理者操作は Cognito 検証が必要で手元では通らないため、
 * 実際の振り分けロジック(buildTeams)を直接呼んで結果を保存する。
 */
import { buildTeams } from "../src/api";
import { generateTeamComments } from "../src/comments";
import { saveEventState } from "../src/db";

const EVENT_CODE = process.env.EVENT_CODE || "JAWS-SAGA";

const PARTICIPANTS = [
  "山田 太郎",
  "佐藤 花子",
  "鈴木 一郎",
  "高橋 二郎",
  "田中 三郎",
  "伊藤 四郎",
  "渡辺 五郎",
  "中村 六子",
  "小林 七海",
  "加藤 八重",
];

async function main() {
  const teams = buildTeams(PARTICIPANTS, 3);
  const comments = generateTeamComments(teams);

  await saveEventState(EVENT_CODE, {
    participants: PARTICIPANTS,
    pattern: { teams: teams.map((t) => ({ name: t.name, size: t.size })) },
    teams,
    comments,
  });

  console.log(`seeded ${EVENT_CODE}:`);
  for (const t of teams) {
    console.log(`  ${t.name} (${t.members.length}名) — ${comments[t.name]}`);
    console.log(`    ${t.members.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
