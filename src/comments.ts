/**
 * チームごとの佐賀弁ひとことコメント。
 * 外部サービスに依存しないので、チーム分けが失敗する要因にならない。
 */
const SAGA_COMMENTS: string[] = [
  "がばい最高なチームワークでがんばりましょう！",
  "そいぎ、みんなで最高の成果ば出そう！",
  "ちかっぱアイデア出して盛り上がっていこう！",
  "ほんなごつよかチームばい、楽しんでいこう！",
  "なんばしよっと？さあ手ば動かすばい！",
  "よかろうもん、まずはやってみゅうで！",
  "ぼちぼちいこう、あせらんでよかよ。",
  "うまか成果ば出して、佐賀ば盛り上げよう！",
  "あったかい雰囲気で、ゆったり進めていこう。",
  "しぇからしかことは忘れて、集中していこう！",
];

/**
 * 各チームに1つずつコメントを割り当てる。
 * チーム数がコメント数を超えた場合のみ重複を許す。
 */
export function generateTeamComments(
  teams: { name: string }[]
): Record<string, string> {
  const pool = [...SAGA_COMMENTS];
  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const result: Record<string, string> = {};
  teams.forEach((t, i) => {
    result[t.name] = pool[i % pool.length];
  });
  return result;
}
