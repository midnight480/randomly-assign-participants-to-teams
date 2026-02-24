import type { D1Database } from "@cloudflare/workers-types";
import type {
  EventPattern,
  EventResponse,
  TeamStatus,
} from "./types";
import {
  sha256Hex,
  parsePattern,
  normalizeDisplayName,
  jsonResponse,
  errorResponse,
} from "./util";

const MAX_DRAW_RETRIES = 3;

/** 佐賀弁の文化語彙（場所・団体・企業・人物を指さない） */
const SAGA_WORDS = [
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

/** 重複なしで N 個の佐賀弁単語をランダムに抽出（リストを省略時は SAGA_WORDS を使用） */
function pickRandomSagaNames(n: number, fromWords: string[] = SAGA_WORDS): string[] {
  if (n <= 0 || n > fromWords.length) return [];
  const shuffled = [...fromWords];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

export async function handleGetEvent(
  db: D1Database,
  eventCode: string
): Promise<Response> {
  const eventCodeNorm = eventCode.trim().toUpperCase();
  if (!eventCodeNorm) {
    return errorResponse("event_code required", 400);
  }

  const event = await db
    .prepare(
      "SELECT id, event_code, title, pattern_json FROM events WHERE event_code = ?"
    )
    .bind(eventCodeNorm)
    .first<{ id: number; event_code: string; title: string; pattern_json: string }>();

  if (!event) {
    return errorResponse("イベントが見つかりません", 404);
  }

  const pattern = parsePattern(event.pattern_json);
  if (!pattern) {
    return errorResponse("パターンが不正です", 500);
  }

  const assignments = await db
    .prepare(
      `SELECT a.team_name, p.display_name
       FROM assignments a
       JOIN participants p ON p.id = a.participant_id AND p.event_id = a.event_id
       WHERE a.event_id = ?
       ORDER BY a.team_name, p.display_name`
    )
    .bind(event.id)
    .all<{ team_name: string; display_name: string }>();

  const byTeam = new Map<string, string[]>();
  for (const t of pattern.teams) {
    byTeam.set(t.name, []);
  }
  for (const row of assignments.results) {
    const arr = byTeam.get(row.team_name);
    if (arr) arr.push(row.display_name);
  }

  const teams: TeamStatus[] = pattern.teams.map((t) => {
    const members = byTeam.get(t.name) ?? [];
    return {
      name: t.name,
      size: t.size,
      assigned: members.length,
      remaining: Math.max(0, t.size - members.length),
      members,
    };
  });

  const totalSlots = teams.reduce((s, t) => s + t.size, 0);
  const assignedCount = teams.reduce((s, t) => s + t.assigned, 0);
  const remainingSlots = totalSlots - assignedCount;

  const body: EventResponse = {
    event_code: event.event_code,
    title: event.title,
    pattern,
    teams,
    total_slots: totalSlots,
    assigned_count: assignedCount,
    unassigned_count: assignments.results.length, // 実際は参加者数で数える
    remaining_slots: remainingSlots,
  };

  const participantCount = await db
    .prepare("SELECT COUNT(*) as c FROM participants WHERE event_id = ?")
    .bind(event.id)
    .first<{ c: number }>();
  body.unassigned_count = (participantCount?.c ?? 0) - assignedCount;

  return jsonResponse(body);
}

export async function handlePostParticipants(
  db: D1Database,
  eventCode: string,
  body: { display_name?: string }
): Promise<Response> {
  const eventCodeNorm = eventCode.trim().toUpperCase();
  const rawName = body?.display_name;
  if (typeof rawName !== "string" || !rawName.trim()) {
    return errorResponse("display_name を入力してください", 400);
  }

  const displayName = normalizeDisplayName(rawName);
  if (!displayName) {
    return errorResponse("表示名を入力してください", 400);
  }

  const event = await db
    .prepare("SELECT id FROM events WHERE event_code = ?")
    .bind(eventCodeNorm)
    .first<{ id: number }>();

  if (!event) {
    return errorResponse("イベントが見つかりません", 404);
  }

  try {
    const insertResult = await db
      .prepare(
        "INSERT INTO participants (event_id, display_name) VALUES (?, ?)"
      )
      .bind(event.id, displayName)
      .run();
    const meta = insertResult.meta as { changes?: number; Changes?: number };
    if ((meta?.changes ?? meta?.Changes ?? 0) > 0) {
      const r = await db
        .prepare(
          "SELECT id, display_name, created_at FROM participants WHERE event_id = ? AND display_name = ?"
        )
        .bind(event.id, displayName)
        .first<{ id: number; display_name: string; created_at: string }>();
      if (r) {
        return jsonResponse({
          participant_id: r.id,
          display_name: r.display_name,
          created_at: r.created_at,
        });
      }
    }
  } catch (e) {
    const err = e as { message?: string };
    if (err.message?.includes("UNIQUE") || err.message?.includes("unique")) {
      return errorResponse(
        "同じ名前の参加者が既に登録されています。名字やニックネームを足してください。",
        409
      );
    }
    throw e;
  }

  const existing = await db
    .prepare(
      "SELECT id, display_name, created_at FROM participants WHERE event_id = ? AND display_name = ?"
    )
    .bind(event.id, displayName)
    .first<{ id: number; display_name: string; created_at: string }>();

  if (existing) {
    return jsonResponse({
      participant_id: existing.id,
      display_name: existing.display_name,
      created_at: existing.created_at,
    });
  }

  return errorResponse("参加者の登録に失敗しました", 500);
}

export async function handlePostDraw(
  db: D1Database,
  eventCode: string,
  body: { display_name?: string }
): Promise<Response> {
  const eventCodeNorm = eventCode.trim().toUpperCase();
  const rawName = body?.display_name;
  if (typeof rawName !== "string" || !rawName.trim()) {
    return errorResponse("display_name を入力してください", 400);
  }

  const displayName = normalizeDisplayName(rawName);
  if (!displayName) {
    return errorResponse("表示名を入力してください", 400);
  }

  const event = await db
    .prepare(
      "SELECT id, pattern_json FROM events WHERE event_code = ?"
    )
    .bind(eventCodeNorm)
    .first<{ id: number; pattern_json: string }>();

  if (!event) {
    return errorResponse("イベントが見つかりません", 404);
  }

  const pattern = parsePattern(event.pattern_json);
  if (!pattern) {
    return errorResponse("パターンが不正です", 500);
  }

  let participantId: number;

  try {
    const insResult = await db
      .prepare(
        "INSERT INTO participants (event_id, display_name) VALUES (?, ?)"
      )
      .bind(event.id, displayName)
      .run();
    const meta2 = insResult.meta as { changes?: number; Changes?: number };
    if ((meta2?.changes ?? meta2?.Changes ?? 0) > 0) {
      const row = await db
        .prepare(
          "SELECT id FROM participants WHERE event_id = ? AND display_name = ?"
        )
        .bind(event.id, displayName)
        .first<{ id: number }>();
      if (!row) return errorResponse("参加者の取得に失敗しました", 500);
      participantId = row.id;
    } else {
      const row = await db
        .prepare(
          "SELECT id FROM participants WHERE event_id = ? AND display_name = ?"
        )
        .bind(event.id, displayName)
        .first<{ id: number }>();
      if (!row) return errorResponse("参加者の取得に失敗しました", 500);
      participantId = row.id;
    }
  } catch (e) {
    const err = e as { message?: string };
    if (err.message?.includes("UNIQUE") || err.message?.includes("unique")) {
      const row = await db
        .prepare(
          "SELECT id FROM participants WHERE event_id = ? AND display_name = ?"
        )
        .bind(event.id, displayName)
        .first<{ id: number }>();
      if (!row) {
        return errorResponse(
          "同じ名前の参加者が既に登録されています。名字やニックネームを足してください。",
          409
        );
      }
      participantId = row.id;
    } else {
      throw e;
    }
  }

  const existingAssignment = await db
    .prepare(
      "SELECT team_name, assigned_at FROM assignments WHERE event_id = ? AND participant_id = ?"
    )
    .bind(event.id, participantId)
    .first<{ team_name: string; assigned_at: string }>();

  if (existingAssignment) {
    return jsonResponse({
      display_name: displayName,
      team_name: existingAssignment.team_name,
      assigned_at: existingAssignment.assigned_at,
      already_assigned: true,
    });
  }

  for (let attempt = 0; attempt < MAX_DRAW_RETRIES; attempt++) {
    const counts = await db
      .prepare(
        `SELECT team_name, COUNT(*) as c FROM assignments WHERE event_id = ? GROUP BY team_name`
      )
      .bind(event.id)
      .all<{ team_name: string; c: number }>();

    const used = new Map<string, number>();
    for (const row of counts.results) {
      used.set(row.team_name, row.c);
    }

    const slots: { team_name: string; remaining: number }[] = [];
    for (const t of pattern.teams) {
      const u = used.get(t.name) ?? 0;
      const remaining = Math.max(0, t.size - u);
      if (remaining > 0) {
        slots.push({ team_name: t.name, remaining });
      }
    }

    if (slots.length === 0) {
      return errorResponse("チームの空き枠がありません", 409);
    }

    const totalRemaining = slots.reduce((s, x) => s + x.remaining, 0);
    let r = Math.floor(Math.random() * totalRemaining);
    let chosenTeam = slots[0].team_name;
    for (const s of slots) {
      if (r < s.remaining) {
        chosenTeam = s.team_name;
        break;
      }
      r -= s.remaining;
    }

    try {
      await db
        .prepare(
          "INSERT INTO assignments (event_id, participant_id, team_name) VALUES (?, ?, ?)"
        )
        .bind(event.id, participantId, chosenTeam)
        .run();
    } catch (e) {
      const err = e as { message?: string };
      if (err.message?.includes("UNIQUE") || err.message?.includes("unique")) {
        const again = await db
          .prepare(
            "SELECT team_name, assigned_at FROM assignments WHERE event_id = ? AND participant_id = ?"
          )
          .bind(event.id, participantId)
          .first<{ team_name: string; assigned_at: string }>();
        if (again) {
          return jsonResponse({
            display_name: displayName,
            team_name: again.team_name,
            assigned_at: again.assigned_at,
            already_assigned: true,
          });
        }
      }
      if (attempt === MAX_DRAW_RETRIES - 1) throw e;
      continue;
    }

    const assignedAt = await db
      .prepare(
        "SELECT assigned_at FROM assignments WHERE event_id = ? AND participant_id = ?"
      )
      .bind(event.id, participantId)
      .first<{ assigned_at: string }>();

    return jsonResponse({
      display_name: displayName,
      team_name: chosenTeam,
      assigned_at: assignedAt?.assigned_at ?? new Date().toISOString(),
      already_assigned: false,
    });
  }

  return errorResponse("抽選に失敗しました。もう一度お試しください。", 500);
}

export async function verifyAdmin(
  db: D1Database,
  eventCode: string,
  adminToken: string | null
): Promise<{ eventId: number } | Response> {
  if (!adminToken?.trim()) {
    return errorResponse("管理者トークンが必要です", 401);
  }

  const eventCodeNorm = eventCode.trim().toUpperCase();
  const event = await db
    .prepare("SELECT id, admin_token_hash FROM events WHERE event_code = ?")
    .bind(eventCodeNorm)
    .first<{ id: number; admin_token_hash: string }>();

  if (!event) {
    return errorResponse("イベントが見つかりません", 404);
  }

  const hash = await sha256Hex(adminToken.trim());
  if (hash !== event.admin_token_hash) {
    return errorResponse("管理者トークンが正しくありません", 403);
  }

  return { eventId: event.id };
}

export async function handleResetAssignments(
  db: D1Database,
  eventCode: string,
  adminToken: string | null
): Promise<Response> {
  const auth = await verifyAdmin(db, eventCode, adminToken);
  if (auth instanceof Response) return auth;

  await db
    .prepare("DELETE FROM assignments WHERE event_id = ?")
    .bind(auth.eventId)
    .run();

  return jsonResponse({ message: "割り当てをリセットしました" });
}

export async function handleResetAll(
  db: D1Database,
  eventCode: string,
  adminToken: string | null
): Promise<Response> {
  const auth = await verifyAdmin(db, eventCode, adminToken);
  if (auth instanceof Response) return auth;

  await db
    .prepare("DELETE FROM assignments WHERE event_id = ?")
    .bind(auth.eventId)
    .run();
  await db
    .prepare("DELETE FROM participants WHERE event_id = ?")
    .bind(auth.eventId)
    .run();

  return jsonResponse({ message: "参加者と割り当てをすべてリセットしました" });
}

export async function handlePatchEvent(
  db: D1Database,
  eventCode: string,
  adminToken: string | null,
  body: { title?: string; pattern?: EventPattern }
): Promise<Response> {
  const auth = await verifyAdmin(db, eventCode, adminToken);
  if (auth instanceof Response) return auth;

  const event = await db
    .prepare("SELECT id, title, pattern_json FROM events WHERE event_code = ?")
    .bind(eventCode.trim().toUpperCase())
    .first<{ id: number; title: string; pattern_json: string }>();

  if (!event) {
    return errorResponse("イベントが見つかりません", 404);
  }

  let newTitle = event.title;
  let newPatternJson = event.pattern_json;

  if (typeof body.title === "string") {
    newTitle = body.title.trim().slice(0, 200) || event.title;
  }

  if (body.pattern?.teams && Array.isArray(body.pattern.teams)) {
    let teams = body.pattern.teams
      .filter((t) => t && typeof t.size === "number" && t.size > 0)
      .map((t) => ({
        name: typeof t.name === "string" ? t.name.trim() : "",
        size: t.size,
      }));
    if (teams.length === 0) {
      return errorResponse("チームは1つ以上必要です", 400);
    }
    if (teams.length > SAGA_WORDS.length) {
      return errorResponse(`チーム数は${SAGA_WORDS.length}以下にしてください`, 400);
    }
    const totalSlots = teams.reduce((s, t) => s + t.size, 0);

    const assignmentCounts = await db
      .prepare(
        "SELECT team_name, COUNT(*) as c FROM assignments WHERE event_id = ? GROUP BY team_name"
      )
      .bind(auth.eventId)
      .all<{ team_name: string; c: number }>();

    const assignedTotal = assignmentCounts.results.reduce((s, r) => s + r.c, 0);
    const byTeam = new Map(assignmentCounts.results.map((r) => [r.team_name, r.c]));

    if (assignedTotal > 0) {
      if (totalSlots < assignedTotal) {
        return errorResponse(
          `既に ${assignedTotal} 名割り当て済みです。総枠は ${assignedTotal} 以上にしてください。`,
          400
        );
      }
      for (const [teamName, count] of byTeam) {
        const t = teams.find((x) => x.name === teamName);
        if (!t) {
          return errorResponse(`割り当て済みの「${teamName}」チームを削除できません。`, 400);
        }
        if (t.size < count) {
          return errorResponse(
            `「${teamName}」チームは ${count} 名割り当て済みのため、枠を ${t.size} より小さくできません。`,
            400
          );
        }
      }
      // 割当ありのときは名前未指定のチームは不可
      const missingName = teams.find((t) => !t.name);
      if (missingName) {
        return errorResponse("割り当て済みのため、チーム名の変更はできません。", 400);
      }
    } else {
      // 割当0のとき: 名前が空のチームにだけ佐賀弁を重複なしで付与
      const used = new Set(teams.filter((t) => t.name).map((t) => t.name));
      const needCount = teams.filter((t) => !t.name).length;
      if (needCount > 0) {
        const pool = SAGA_WORDS.filter((w) => !used.has(w));
        const picked = pickRandomSagaNames(needCount, pool);
        if (picked.length < needCount) {
          return errorResponse(
            `チーム名に使える佐賀弁の単語が足りません（${needCount}個必要）。`,
            400
          );
        }
        let idx = 0;
        teams = teams.map((t) => ({
          name: t.name || picked[idx++] || t.name,
          size: t.size,
        }));
      }
    }

    newPatternJson = JSON.stringify({ teams });
  }

  await db
    .prepare("UPDATE events SET title = ?, pattern_json = ? WHERE id = ?")
    .bind(newTitle, newPatternJson, event.id)
    .run();

  return jsonResponse({
    message: "イベント設定を更新しました",
    title: newTitle,
    pattern: JSON.parse(newPatternJson),
  });
}

/** チーム名を再生成（割当0人のときのみ） */
export async function handleRegenerateTeamNames(
  db: D1Database,
  eventCode: string,
  adminToken: string | null
): Promise<Response> {
  const auth = await verifyAdmin(db, eventCode, adminToken);
  if (auth instanceof Response) return auth;

  const event = await db
    .prepare("SELECT id, pattern_json FROM events WHERE event_code = ?")
    .bind(eventCode.trim().toUpperCase())
    .first<{ id: number; pattern_json: string }>();

  if (!event) {
    return errorResponse("イベントが見つかりません", 404);
  }

  const assignmentCount = await db
    .prepare("SELECT COUNT(*) as c FROM assignments WHERE event_id = ?")
    .bind(auth.eventId)
    .first<{ c: number }>();
  const assignedTotal = assignmentCount?.c ?? 0;
  if (assignedTotal > 0) {
    return errorResponse("割り当てが1人以上あるため、チーム名の再生成はできません。", 400);
  }

  const pattern = parsePattern(event.pattern_json);
  if (!pattern || !pattern.teams?.length) {
    return errorResponse("パターンが不正です", 500);
  }

  const names = pickRandomSagaNames(pattern.teams.length);
  const teams = pattern.teams.map((t, i) => ({
    name: names[i] ?? t.name,
    size: t.size,
  }));
  const newPatternJson = JSON.stringify({ teams });

  await db
    .prepare("UPDATE events SET pattern_json = ? WHERE id = ?")
    .bind(newPatternJson, event.id)
    .run();

  return jsonResponse({
    message: "チーム名を再生成しました",
    pattern: { teams },
  });
}
