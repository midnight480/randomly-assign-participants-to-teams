import { generateTeamComments } from "./comments";
import { verifyAdminToken } from "./auth";
import { publishShuffleEvent } from "./events";
import { getEventState, saveEventState, setParticipants } from "./db";
import type { Team } from "./db";
import { normalizeDisplayName, jsonResponse, errorResponse } from "./util";

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

  const saved = await saveEventState(eventCode, {
    pattern: { teams: [] },
    teams: [],
    comments: {},
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
