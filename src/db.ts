import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.TABLE_NAME || "team-drawer";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export interface Team {
  name: string;
  size: number;
  members: string[];
}

export interface EventState {
  eventCode: string;
  title: string;
  pattern: { teams: { name: string; size: number }[] };
  teams: Team[];
  comments: Record<string, string>;
  participants: string[];
  updatedAt: string;
}

const DEFAULT_TITLE = "JAWS-UG佐賀 チーム割り当て";

function normalizeCode(eventCode: string): string {
  return eventCode.trim().toUpperCase();
}

function emptyState(code: string): EventState {
  return {
    eventCode: code,
    title: DEFAULT_TITLE,
    pattern: { teams: [] },
    teams: [],
    comments: {},
    participants: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * イベント状態を1アイテムとして読む。未作成なら空の状態を返す（書き込みはしない）。
 * 単発イベント用なので、1イベント = 1アイテムで持つ。
 */
export async function getEventState(eventCode: string): Promise<EventState> {
  const code = normalizeCode(eventCode);
  const res = await doc.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: `EVENT#${code}` } })
  );

  if (!res.Item) {
    return emptyState(code);
  }

  const item = res.Item as Partial<EventState>;
  return {
    eventCode: code,
    title: item.title || DEFAULT_TITLE,
    pattern: item.pattern || { teams: [] },
    teams: item.teams || [],
    comments: item.comments || {},
    participants: item.participants || [],
    updatedAt: item.updatedAt || new Date().toISOString(),
  };
}

export async function saveEventState(
  eventCode: string,
  patch: Partial<Omit<EventState, "eventCode" | "updatedAt">>
): Promise<EventState> {
  const code = normalizeCode(eventCode);
  const current = await getEventState(code);
  const next: EventState = {
    ...current,
    ...patch,
    eventCode: code,
    updatedAt: new Date().toISOString(),
  };

  await doc.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { pk: `EVENT#${code}`, ...next },
    })
  );

  return next;
}

export async function setParticipants(
  eventCode: string,
  participants: string[]
): Promise<EventState> {
  return saveEventState(eventCode, { participants });
}
