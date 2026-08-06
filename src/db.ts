import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.TABLE_NAME || "team-drawer";

// DYNAMODB_ENDPOINT はローカルテスト (DynamoDB Local) 用。Lambda 上では未設定。
const doc = DynamoDBDocumentClient.from(
  new DynamoDBClient(
    process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}
  ),
  { marshallOptions: { removeUndefinedValues: true } }
);

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
  /** 楽観ロック用。参加者が同時にくじを引いても更新が消えないようにする */
  version: number;
}

/**
 * 画面に出すイベント名。デプロイ時の EVENT_TITLE で差し替えられる。
 * EVENT_CODE を JBUG-SAGA などに変えたとき、タイトルだけ「JAWS-UG佐賀」の
 * まま残らないようにするための逃げ道。
 */
export const DEFAULT_TITLE = process.env.EVENT_TITLE || "JAWS-UG佐賀 チーム割り当て";

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
    version: 0,
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
    version: item.version || 0,
  };
}

/**
 * 読み出し → 変更 → 条件付き書き込み。
 * 参加者が一斉にくじを引くと単純な上書きでは更新が失われるため、
 * version を条件にして衝突したら読み直して再試行する。
 */
export async function updateEventState(
  eventCode: string,
  mutate: (state: EventState) => Partial<Omit<EventState, "eventCode" | "updatedAt" | "version">> | null,
  maxRetries = 8
): Promise<EventState> {
  const code = normalizeCode(eventCode);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const current = await getEventState(code);
    const patch = mutate(current);
    if (patch === null) return current; // 変更不要

    const next: EventState = {
      ...current,
      ...patch,
      eventCode: code,
      updatedAt: new Date().toISOString(),
      version: current.version + 1,
    };

    try {
      await doc.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: { pk: `EVENT#${code}`, ...next },
          // 誰も書き換えていないときだけ成功させる
          ConditionExpression:
            "attribute_not_exists(pk) OR version = :expected",
          ExpressionAttributeValues: { ":expected": current.version },
        })
      );
      return next;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // 競合。少し待って読み直す
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 60));
        continue;
      }
      throw err;
    }
  }

  throw new Error("同時アクセスが多いため保存できませんでした。もう一度お試しください");
}

export async function saveEventState(
  eventCode: string,
  patch: Partial<Omit<EventState, "eventCode" | "updatedAt" | "version">>
): Promise<EventState> {
  return updateEventState(eventCode, () => patch);
}

export async function setParticipants(
  eventCode: string,
  participants: string[]
): Promise<EventState> {
  return saveEventState(eventCode, { participants });
}
