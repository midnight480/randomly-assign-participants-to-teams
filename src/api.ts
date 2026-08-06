import { generateTeamComments } from "./comments";
import { verifyAdminToken } from "./auth";
import { publishShuffleEvent } from "./events";
import { getEventState, saveEventState, setParticipants, updateEventState } from "./db";
import type { EventState, Team } from "./db";
import {
  normalizeDisplayName,
  normalizeTeamName,
  jsonResponse,
  errorResponse,
} from "./util";

/** 1イベントあたりの参加者数上限（DynamoDB のアイテムサイズ上限に対する保険） */
export const MAX_PARTICIPANTS = 500;

/** チーム数の上限。会場で見て分かる範囲＋佐賀弁の語彙数に収める */
export const MAX_TEAMS = 20;

/** チーム名の最大文字数（会場ディスプレイで折り返さない程度） */
export const MAX_TEAM_NAME_LENGTH = 20;

export const SAGA_WORDS = [
  "がばい",
  "やーらしか",
  "そいぎ",
  "どがん",
  "ぬくか",
  "ぬっか",
  "ほんなごつ",
  "よか",
  "よかね",
  "よかろうもん",
  "たいぎゃ",
  "なんばしよっと",
  "なんばいうと",
  "なんしよっと",
  "しぇからしか",
  "すーすーする",
  "ほんなこて",
  "ちかっぱ",
  "あーね",
  "そげん",
  "そげな",
  "はよ",
  "ぼちぼち",
  "よか感じ",
  "うまか",
  "うまかね",
  "あったか",
  "のんびり",
  "ゆったり",
  "ほっこり",
];

export function pickRandomSagaNames(n: number, fromWords: string[] = SAGA_WORDS): string[] {
  if (n <= 0) return [];
  const pool = [...fromWords];
  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  if (n <= pool.length) {
    return pool.slice(0, n);
  }
  // Fill remaining if n > pool length
  const res = [...pool];
  for (let i = pool.length; i < n; i++) {
    res.push(`チーム${i + 1}`);
  }
  return res;
}

/**
 * 指定されたチーム名を count 個ぶんに整える（純粋関数）。
 *
 * - 空欄は佐賀弁から自動命名する（既に使われている名前は避ける）
 * - 重複はエラー。チームは名前で識別しているため、同名があると
 *   くじ引きで 1 人が複数チームに入るなど壊れ方が分かりにくい
 */
export function resolveTeamNames(
  rawNames: string[],
  count: number
): { names: string[]; error?: string } {
  const requested = (rawNames || [])
    .slice(0, count)
    .map((n) => normalizeTeamName(n, MAX_TEAM_NAME_LENGTH));

  const used = new Set(requested.filter(Boolean));
  if (used.size !== requested.filter(Boolean).length) {
    return { names: [], error: "チーム名が重複しています。それぞれ別の名前にしてください" };
  }

  // 自動命名は、手で付けた名前と衝突しない語だけから選ぶ
  const auto = pickRandomSagaNames(
    count,
    SAGA_WORDS.filter((w) => !used.has(w))
  );

  const names: string[] = [];
  let autoIdx = 0;
  for (let i = 0; i < count; i++) {
    const given = requested[i];
    if (given) {
      names.push(given);
      continue;
    }
    let candidate = auto[autoIdx++] || `チーム${i + 1}`;
    while (used.has(candidate)) {
      candidate = auto[autoIdx++] || `チーム${i + 1}-${autoIdx}`;
    }
    used.add(candidate);
    names.push(candidate);
  }

  return { names };
}

/**
 * 既存のチームを保ったまま、チーム数と名前だけ差し替える（純粋関数）。
 *
 * 引き直しと違って全員をシャッフルし直さない。すでにくじを引いた人が
 * 「管理者が名前を直しただけ」でチームを移されると、会場が混乱するため。
 * チーム数を減らしたときだけ、あふれたメンバーを人数の少ないチームへ移す。
 */
export function applyTeamConfig(
  currentTeams: Team[],
  names: string[]
): Team[] {
  const count = names.length;

  // 先頭から count 個は名前だけ差し替えて中身を引き継ぐ
  const teams: Team[] = names.map((name, i) => {
    const members = currentTeams[i] ? [...(currentTeams[i].members || [])] : [];
    return { name, size: members.length, members };
  });

  // 減った分のメンバーは、そのつど一番少ないチームへ入れる（同数なら先頭）
  const orphans = currentTeams.slice(count).flatMap((t) => t.members || []);
  for (const member of orphans) {
    let target = teams[0];
    for (const t of teams) {
      if (t.members.length < target.members.length) target = t;
    }
    target.members.push(member);
    target.size = target.members.length;
  }

  return teams;
}

/**
 * 指定した参加者を、参加者リストとチームの両方から取り除く（純粋関数）。
 *
 * チーム名・チーム数・ひとことコメントは触らない。当日に「間違えて2回入れた」
 * 「テストで入れた名前が残っている」を消すための操作なので、
 * 残った人のチームまで動いてしまうと困る。
 */
export function withoutParticipants(
  teams: Team[],
  participants: string[],
  namesToRemove: string[]
): { teams: Team[]; participants: string[]; removed: string[]; notFound: string[] } {
  const targets = new Set(
    namesToRemove.map((n) => normalizeDisplayName(n || "")).filter(Boolean)
  );

  const present = new Set([
    ...participants,
    ...teams.flatMap((t) => t.members || []),
  ]);

  const removed: string[] = [];
  const notFound: string[] = [];
  for (const name of targets) {
    (present.has(name) ? removed : notFound).push(name);
  }

  return {
    teams: teams.map((t) => {
      const members = (t.members || []).filter((m) => !targets.has(m));
      return { ...t, members, size: members.length };
    }),
    participants: participants.filter((p) => !targets.has(p)),
    removed,
    notFound,
  };
}

/**
 * 参加者をチームへ振り分ける（純粋関数）。
 * 元の実装と同じく Fisher-Yates でシャッフルし、余りを先頭チームから 1 名ずつ配る。
 * 認証・永続化・通知から切り離してあるのでそのままテストできる。
 */
export function buildTeams(
  participants: string[],
  teamCount: number,
  teamNames: string[] = []
): Team[] {
  const count = Math.max(1, teamCount);

  // 指定が足りない分だけ佐賀弁で埋める。全部を捨てて付け直すと、
  // 管理画面で 1 つだけ名前を変えたときに他の名前まで変わってしまう。
  const resolved = resolveTeamNames(teamNames, count);
  const names = resolved.error ? resolveTeamNames([], count).names : resolved.names;

  const shuffledNames = [...participants];
  for (let i = shuffledNames.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledNames[i], shuffledNames[j]] = [shuffledNames[j], shuffledNames[i]];
  }

  const baseSize = Math.floor(shuffledNames.length / count);
  const remainder = shuffledNames.length % count;

  const teams: Team[] = [];
  let memberIdx = 0;

  for (let i = 0; i < count; i++) {
    const size = baseSize + (i < remainder ? 1 : 0);
    const members = shuffledNames.slice(memberIdx, memberIdx + size);
    memberIdx += size;

    teams.push({
      name: names[i] || `チーム${i + 1}`,
      size,
      members,
    });
  }

  return teams;
}

/** くじ引きで最初にチームを作るときの既定チーム数 */
export const DEFAULT_TEAM_COUNT = Number(process.env.TEAM_COUNT) || 4;

/**
 * 参加者が自分でくじを引く。管理者の操作は不要。
 *
 * main ブランチは事前に決めた「枠」を埋めていく方式だったが、
 * 枠が尽きると参加できなくなるため、ここでは上限を設けず
 * 「いま一番人数が少ないチーム」に入れる（同数なら抽選）。
 * これで事前の人数見積もりが不要になり、遅刻者もそのまま参加できる。
 */
export async function handleDrawTeam(
  eventCode: string,
  body: { display_name?: string }
): Promise<Response> {
  const displayName = normalizeDisplayName(body?.display_name || "");
  if (!displayName) {
    return errorResponse("表示名を入力してください", 400);
  }

  // すでに引いていれば同じ結果を返す（連打・再読み込みで二重登録しない）
  const before = await getEventState(eventCode);
  const existing = findTeamOf(before, displayName);
  if (existing) {
    return jsonResponse({
      display_name: displayName,
      team_name: existing.name,
      comment: before.comments[existing.name] || "",
      already_assigned: true,
    });
  }

  if (before.participants.length >= MAX_PARTICIPANTS) {
    return errorResponse(`参加者数の上限(${MAX_PARTICIPANTS}名)に達しています`, 400);
  }

  let assignedTeam = "";

  const saved = await updateEventState(eventCode, (state) => {
    // 再試行中に他の人の書き込みで自分が入っていたらそれを採用する
    const already = findTeamOf(state, displayName);
    if (already) {
      assignedTeam = already.name;
      return null;
    }

    let teams = state.teams;
    let comments = state.comments;

    // 最初の1人でチームを作る
    if (teams.length === 0) {
      const names = pickRandomSagaNames(DEFAULT_TEAM_COUNT);
      teams = names.map((name) => ({ name, size: 0, members: [] }));
      comments = generateTeamComments(teams);
    }

    // 一番少ないチーム（同数なら抽選）
    const min = Math.min(...teams.map((t) => t.members.length));
    const candidates = teams.filter((t) => t.members.length === min);
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    assignedTeam = target.name;

    const nextTeams = teams.map((t) =>
      t.name === target.name
        ? { ...t, members: [...t.members, displayName], size: t.members.length + 1 }
        : t
    );

    // 念のため重複を弾く（リセット直後など、リストにだけ残っている場合に備える）
    const participants = state.participants.includes(displayName)
      ? state.participants
      : [...state.participants, displayName];

    return {
      teams: nextTeams,
      comments,
      participants,
      pattern: { teams: nextTeams.map((t) => ({ name: t.name, size: t.size })) },
    };
  });

  await publishShuffleEvent(eventCode, {
    event_code: saved.eventCode,
    teams: saved.teams.map((t) => ({ ...t, comment: saved.comments[t.name] || "" })),
    comments: saved.comments,
    assigned_count: saved.participants.length,
    updated_at: saved.updatedAt,
  });

  return jsonResponse({
    display_name: displayName,
    team_name: assignedTeam,
    comment: saved.comments[assignedTeam] || "",
    already_assigned: false,
  });
}

function findTeamOf(state: EventState, displayName: string): Team | null {
  return state.teams.find((t) => (t.members || []).indexOf(displayName) !== -1) || null;
}

export async function handleGetEvent(eventCode: string): Promise<Response> {
  const state = await getEventState(eventCode);

  const teams = state.teams.map((t) => ({
    ...t,
    comment: state.comments[t.name] || "",
  }));

  const totalAssigned = teams.reduce((acc, t) => acc + (t.members ? t.members.length : 0), 0);

  return jsonResponse({
    event_code: state.eventCode,
    title: state.title,
    pattern: state.pattern,
    teams,
    comments: state.comments,
    total_slots: teams.reduce((acc, t) => acc + t.size, 0),
    assigned_count: totalAssigned,
    participant_count: state.participants.length,
    participants: state.participants,
    updated_at: state.updatedAt,
  });
}

export async function handlePostParticipants(
  eventCode: string,
  body: { display_name?: string; names?: string[] }
): Promise<Response> {
  const rawNames = body.names || (body.display_name ? [body.display_name] : []);
  if (!rawNames || rawNames.length === 0) {
    return errorResponse("参加者名を入力してください", 400);
  }

  const state = await getEventState(eventCode);
  const existing = new Set(state.participants);
  const added: string[] = [];

  for (const raw of rawNames) {
    const name = normalizeDisplayName(raw);
    if (name && !existing.has(name)) {
      existing.add(name);
      added.push(name);
    }
  }

  // 参加者登録は認証不要なので、大量登録で DynamoDB のアイテムサイズ上限(400KB)に
  // 当たってイベントごと壊れないよう上限を設ける。中途半端に保存されると
  // 状況が分かりにくいため、超える場合はまとめて拒否する。
  if (state.participants.length + added.length > MAX_PARTICIPANTS) {
    return errorResponse(
      `参加者数が上限(${MAX_PARTICIPANTS}名)を超えるため登録できません`,
      400
    );
  }

  if (added.length > 0) {
    await setParticipants(eventCode, [...state.participants, ...added]);
  }

  return jsonResponse({
    message: `${added.length}名の参加者を登録しました`,
    added,
  });
}

export async function handleExecuteShuffle(
  eventCode: string,
  authHeader: string | null,
  body: {
    participant_names?: string[];
    team_count?: number;
    team_names?: string[];
  }
): Promise<Response> {
  const isAuthorized = await verifyAdminToken(authHeader);
  if (!isAuthorized) {
    return errorResponse("管理者権限が必要です (Cognito Token Invalid)", 401);
  }

  const state = await getEventState(eventCode);

  // 1. Gather participants
  let participants: string[] = [];
  if (body.participant_names && Array.isArray(body.participant_names) && body.participant_names.length > 0) {
    participants = body.participant_names
      .map((n) => normalizeDisplayName(n))
      .filter(Boolean);
  } else {
    participants = state.participants;
  }

  if (participants.length === 0) {
    return errorResponse("シャッフル対象の参加者が登録されていません", 400);
  }
  if (participants.length > MAX_PARTICIPANTS) {
    return errorResponse(
      `参加者は${MAX_PARTICIPANTS}名までです（${participants.length}名が指定されました）`,
      400
    );
  }

  // 2. Determine team count and 3. shuffle
  const teamCount = Math.max(1, body.team_count || Math.min(4, participants.length));
  if (teamCount > MAX_TEAMS) {
    return errorResponse(`チーム数は${MAX_TEAMS}までです`, 400);
  }

  const resolved = resolveTeamNames(body.team_names || [], teamCount);
  if (resolved.error) {
    return errorResponse(resolved.error, 400);
  }

  const teams = buildTeams(participants, teamCount, resolved.names);

  // 4. Attach a Saga-dialect comment per team
  const comments = generateTeamComments(teams);

  // 5. Persist
  const saved = await saveEventState(eventCode, {
    participants,
    pattern: { teams: teams.map((t) => ({ name: t.name, size: t.size })) },
    teams,
    comments,
  });

  const responsePayload = {
    event_code: saved.eventCode,
    title: saved.title,
    teams: teams.map((t) => ({ ...t, comment: comments[t.name] || "" })),
    comments,
    assigned_count: participants.length,
    updated_at: saved.updatedAt,
  };

  // 6. Publish AppSync Event for real-time update
  await publishShuffleEvent(eventCode, responsePayload);

  return jsonResponse({
    message: "シャッフルが完了しました",
    ...responsePayload,
  });
}

/**
 * チーム数とチーム名だけを変更する（引き直しはしない）。
 *
 * 開場前にチームを用意しておく用途と、当日「チーム名を変えたい」に応える用途を
 * 1 つのエンドポイントで賄う。参加者が同時にくじを引いていても更新が消えないよう
 * updateEventState（楽観ロック）で読み直してから書く。
 */
export async function handleConfigureTeams(
  eventCode: string,
  authHeader: string | null,
  body: { team_count?: number; team_names?: string[] }
): Promise<Response> {
  const isAuthorized = await verifyAdminToken(authHeader);
  if (!isAuthorized) {
    return errorResponse("管理者権限が必要です", 401);
  }

  const rawNames = Array.isArray(body.team_names) ? body.team_names : [];
  const count = Number(
    body.team_count !== undefined && body.team_count !== null
      ? body.team_count
      : rawNames.length
  );

  if (!Number.isInteger(count) || count < 1) {
    return errorResponse("チーム数は1以上の整数で指定してください", 400);
  }
  if (count > MAX_TEAMS) {
    return errorResponse(`チーム数は${MAX_TEAMS}までです`, 400);
  }

  const resolved = resolveTeamNames(rawNames, count);
  if (resolved.error) {
    return errorResponse(resolved.error, 400);
  }

  const saved = await updateEventState(eventCode, (state) => {
    const teams = applyTeamConfig(state.teams, resolved.names);

    // コメントはチーム名がキー。改名しても同じ位置のチームには
    // 同じひとことを引き継ぎ、新しく増えたチームにだけ付け直す。
    const generated = generateTeamComments(teams);
    const comments: Record<string, string> = {};
    teams.forEach((t, i) => {
      const previous = state.teams[i];
      const carried = previous ? state.comments[previous.name] : "";
      comments[t.name] = carried || generated[t.name];
    });

    return {
      teams,
      comments,
      pattern: { teams: teams.map((t) => ({ name: t.name, size: t.size })) },
    };
  });

  const responsePayload = {
    event_code: saved.eventCode,
    title: saved.title,
    teams: saved.teams.map((t) => ({ ...t, comment: saved.comments[t.name] || "" })),
    comments: saved.comments,
    assigned_count: saved.participants.length,
    updated_at: saved.updatedAt,
  };

  await publishShuffleEvent(eventCode, responsePayload);

  return jsonResponse({
    message: `チーム構成を更新しました（${saved.teams.length}チーム）`,
    ...responsePayload,
  });
}

/** 参加者削除後の状態を返す（個別・全員で共通） */
function participantsResponse(saved: EventState, message: string): Response {
  return jsonResponse({
    message,
    event_code: saved.eventCode,
    title: saved.title,
    teams: saved.teams.map((t) => ({ ...t, comment: saved.comments[t.name] || "" })),
    comments: saved.comments,
    assigned_count: saved.participants.length,
    participants: saved.participants,
    updated_at: saved.updatedAt,
  });
}

/**
 * 指定した参加者を削除する。チーム構成（名前・数）は変えない。
 */
export async function handleRemoveParticipants(
  eventCode: string,
  authHeader: string | null,
  body: { names?: string[]; display_name?: string }
): Promise<Response> {
  const isAuthorized = await verifyAdminToken(authHeader);
  if (!isAuthorized) {
    return errorResponse("管理者権限が必要です", 401);
  }

  const rawNames = Array.isArray(body.names)
    ? body.names
    : body.display_name
      ? [body.display_name]
      : [];

  if (rawNames.length === 0) {
    return errorResponse("削除する参加者名を指定してください", 400);
  }

  let removed: string[] = [];
  let notFound: string[] = [];

  const saved = await updateEventState(eventCode, (state) => {
    const next = withoutParticipants(state.teams, state.participants, rawNames);
    removed = next.removed;
    notFound = next.notFound;

    if (next.removed.length === 0) return null; // 誰も居なければ書き込まない

    return {
      teams: next.teams,
      participants: next.participants,
      pattern: { teams: next.teams.map((t) => ({ name: t.name, size: t.size })) },
    };
  });

  if (removed.length === 0) {
    return errorResponse(
      `該当する参加者が見つかりません（${notFound.join("、")}）`,
      404
    );
  }

  const responsePayload = {
    event_code: saved.eventCode,
    teams: saved.teams.map((t) => ({ ...t, comment: saved.comments[t.name] || "" })),
    comments: saved.comments,
    assigned_count: saved.participants.length,
    updated_at: saved.updatedAt,
  };
  await publishShuffleEvent(eventCode, responsePayload);

  const suffix = notFound.length > 0 ? `（${notFound.join("、")} は見つかりませんでした）` : "";
  return participantsResponse(saved, `${removed.join("、")} を削除しました${suffix}`);
}

/**
 * 参加者を全員削除する。チーム名・チーム数は残るので、
 * 同じチーム構成のまま最初からやり直せる。
 */
export async function handleClearParticipants(
  eventCode: string,
  authHeader: string | null
): Promise<Response> {
  const isAuthorized = await verifyAdminToken(authHeader);
  if (!isAuthorized) {
    return errorResponse("管理者権限が必要です", 401);
  }

  const saved = await updateEventState(eventCode, (state) => {
    const teams = state.teams.map((t) => ({ ...t, members: [], size: 0 }));
    return {
      teams,
      participants: [],
      pattern: { teams: teams.map((t) => ({ name: t.name, size: 0 })) },
    };
  });

  const responsePayload = {
    event_code: saved.eventCode,
    teams: saved.teams.map((t) => ({ ...t, comment: saved.comments[t.name] || "" })),
    comments: saved.comments,
    assigned_count: 0,
    updated_at: saved.updatedAt,
  };
  await publishShuffleEvent(eventCode, responsePayload);

  return participantsResponse(saved, "参加者を全員削除しました（チーム構成は残しています）");
}

export async function handleResetAssignments(
  eventCode: string,
  authHeader: string | null
): Promise<Response> {
  const isAuthorized = await verifyAdminToken(authHeader);
  if (!isAuthorized) {
    return errorResponse("管理者権限が必要です", 401);
  }

  // 参加者リストも消す。残したままだと、同じ人がもう一度くじを引いたときに
  // リストへ二重に積まれてしまう（当日リセットして仕切り直す運用で必ず踏む）。
  const saved = await saveEventState(eventCode, {
    pattern: { teams: [] },
    teams: [],
    comments: {},
    participants: [],
  });

  const responsePayload = {
    event_code: saved.eventCode,
    teams: [],
    comments: {},
    assigned_count: 0,
    updated_at: saved.updatedAt,
  };

  await publishShuffleEvent(eventCode, responsePayload);

  return jsonResponse({ message: "割り当てをリセットしました" });
}
