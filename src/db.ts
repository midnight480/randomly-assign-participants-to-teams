import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

let isInitialized = false;

export async function ensureDbSchema() {
  if (isInitialized) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "EventState" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "eventCode" TEXT NOT NULL UNIQUE,
        "title" TEXT NOT NULL DEFAULT 'JAWS-UG佐賀 チーム割り当て',
        "patternJson" TEXT NOT NULL DEFAULT '{"teams":[]}',
        "teamsJson" TEXT NOT NULL DEFAULT '[]',
        "commentsJson" TEXT NOT NULL DEFAULT '{}',
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Participant" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "eventCode" TEXT NOT NULL,
        "displayName" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE("eventCode", "displayName")
      );
    `);
    isInitialized = true;
  } catch (err) {
    console.error("Failed to initialize SQLite schema:", err);
  }
}

export async function getOrCreateEventState(eventCode: string) {
  await ensureDbSchema();
  const code = eventCode.trim().toUpperCase();
  let state = await prisma.eventState.findUnique({
    where: { eventCode: code },
  });

  if (!state) {
    state = await prisma.eventState.create({
      data: {
        eventCode: code,
        title: "JAWS-UG佐賀 チーム割り当て",
        patternJson: JSON.stringify({
          teams: [
            { name: "がばい", size: 5 },
            { name: "やーらしか", size: 5 },
            { name: "そいぎ", size: 5 },
          ],
        }),
        teamsJson: JSON.stringify([]),
        commentsJson: JSON.stringify({}),
      },
    });
  }

  return state;
}

export async function saveEventState(
  eventCode: string,
  data: {
    title?: string;
    patternJson?: string;
    teamsJson?: string;
    commentsJson?: string;
  }
) {
  await ensureDbSchema();
  const code = eventCode.trim().toUpperCase();
  return prisma.eventState.upsert({
    where: { eventCode: code },
    update: data,
    create: {
      eventCode: code,
      title: data.title || "JAWS-UG佐賀 チーム割り当て",
      patternJson: data.patternJson || JSON.stringify({ teams: [] }),
      teamsJson: data.teamsJson || JSON.stringify([]),
      commentsJson: data.commentsJson || JSON.stringify({}),
    },
  });
}

export async function addParticipant(eventCode: string, displayName: string) {
  await ensureDbSchema();
  const code = eventCode.trim().toUpperCase();
  const existing = await prisma.participant.findFirst({
    where: { eventCode: code, displayName },
  });
  if (existing) {
    return existing;
  }
  return prisma.participant.create({
    data: {
      eventCode: code,
      displayName,
    },
  });
}

export async function getParticipants(eventCode: string) {
  await ensureDbSchema();
  const code = eventCode.trim().toUpperCase();
  return prisma.participant.findMany({
    where: { eventCode: code },
    orderBy: { id: "asc" },
  });
}

export async function clearParticipants(eventCode: string) {
  await ensureDbSchema();
  const code = eventCode.trim().toUpperCase();
  await prisma.participant.deleteMany({
    where: { eventCode: code },
  });
}
