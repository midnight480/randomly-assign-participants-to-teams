import { generateTeamComments } from "./bedrock";
import { verifyAdminToken } from "./auth";
import { publishShuffleEvent } from "./events";
import {
  getOrCreateEventState,
  saveEventState,
  addParticipant,
  getParticipants,
  clearParticipants,
} from "./db";
import { parsePattern, normalizeDisplayName, jsonResponse, errorResponse } from "./util";

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

export async function handleGetEvent(eventCode: string): Promise<Response> {
  const state = await getOrCreateEventState(eventCode);
  const pattern = parsePattern(state.patternJson) || { teams: [] };

  let teams: { name: string; size: number; members: string[]; comment?: string }[] = [];
  try {
    teams = JSON.parse(state.teamsJson);
  } catch {}

  let comments: Record<string, string> = {};
  try {
    comments = JSON.parse(state.commentsJson);
  } catch {}

  // Attach comments to teams
  teams = teams.map((t) => ({
    ...t,
    comment: comments[t.name] || "",
  }));

  const allParticipants = await getParticipants(eventCode);
  const totalAssigned = teams.reduce((acc, t) => acc + (t.members ? t.members.length : 0), 0);

  return jsonResponse({
    event_code: state.eventCode,
    title: state.title,
    pattern,
    teams,
    comments,
    total_slots: teams.reduce((acc, t) => acc + t.size, 0),
    assigned_count: totalAssigned,
    participant_count: allParticipants.length,
    participants: allParticipants.map((p) => p.displayName),
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

  const added: string[] = [];
  for (const raw of rawNames) {
    const name = normalizeDisplayName(raw);
    if (name) {
      await addParticipant(eventCode, name);
      added.push(name);
    }
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

  const state = await getOrCreateEventState(eventCode);

  // 1. Gather participants
  let participants: string[] = [];
  if (body.participant_names && Array.isArray(body.participant_names) && body.participant_names.length > 0) {
    participants = body.participant_names
      .map((n) => normalizeDisplayName(n))
      .filter(Boolean);

    // Update DB list of participants
    await clearParticipants(eventCode);
    for (const p of participants) {
      await addParticipant(eventCode, p);
    }
  } else {
    const dbParticipants = await getParticipants(eventCode);
    participants = dbParticipants.map((p) => p.displayName);
  }

  if (participants.length === 0) {
    return errorResponse("シャッフル対象の参加者が登録されていません", 400);
  }

  // 2. Determine team count and names
  const teamCount = Math.max(1, body.team_count || Math.min(4, participants.length));
  let teamNames: string[] = body.team_names || [];

  if (teamNames.length < teamCount) {
    const pickedSaga = pickRandomSagaNames(teamCount);
    teamNames = pickedSaga;
  }

  // 3. Shuffle participants algorithm (Random distribution)
  const shuffledNames = [...participants];
  for (let i = shuffledNames.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledNames[i], shuffledNames[j]] = [shuffledNames[j], shuffledNames[i]];
  }

  // Calculate capacities
  const baseSize = Math.floor(shuffledNames.length / teamCount);
  const remainder = shuffledNames.length % teamCount;

  const teams: { name: string; size: number; members: string[] }[] = [];
  let memberIdx = 0;

  for (let i = 0; i < teamCount; i++) {
    const size = baseSize + (i < remainder ? 1 : 0);
    const members = shuffledNames.slice(memberIdx, memberIdx + size);
    memberIdx += size;

    teams.push({
      name: teamNames[i] || `チーム${i + 1}`,
      size,
      members,
    });
  }

  // 4. Generate Bedrock team comments (with fallback catch)
  const comments = await generateTeamComments(teams);

  // 5. Save to Prisma DB
  const patternJson = JSON.stringify({
    teams: teams.map((t) => ({ name: t.name, size: t.size })),
  });
  const teamsJson = JSON.stringify(teams);
  const commentsJson = JSON.stringify(comments);

  await saveEventState(eventCode, {
    patternJson,
    teamsJson,
    commentsJson,
  });

  const responsePayload = {
    event_code: state.eventCode,
    title: state.title,
    teams: teams.map((t) => ({ ...t, comment: comments[t.name] || "" })),
    comments,
    assigned_count: participants.length,
    updated_at: new Date().toISOString(),
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

  await saveEventState(eventCode, {
    teamsJson: JSON.stringify([]),
    commentsJson: JSON.stringify({}),
  });

  const responsePayload = {
    event_code: eventCode,
    teams: [],
    comments: {},
    assigned_count: 0,
    updated_at: new Date().toISOString(),
  };

  await publishShuffleEvent(eventCode, responsePayload);

  return jsonResponse({ message: "割り当てをリセットしました" });
}
