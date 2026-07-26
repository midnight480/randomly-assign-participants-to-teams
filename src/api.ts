import { generateTeamComments } from "./comments";
import { verifyAdminToken } from "./auth";
import { publishShuffleEvent } from "./events";
import { getEventState, saveEventState, setParticipants, updateEventState } from "./db";
import type { EventState, Team } from "./db";
import { normalizeDisplayName, jsonResponse, errorResponse } from "./util";

/** 1イベントあたりの参加者数上限（DynamoDB のアイテムサイズ上限に対する保険） */
export const MAX_PARTICIPANTS = 500;

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

  let names = teamNames;
  if (names.length < count) {
    names = pickRandomSagaNames(count);
  }

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
  const teams = buildTeams(participants, teamCount, body.team_names || []);

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
