import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  handleGetEvent,
  handlePostParticipants,
  handleDrawTeam,
  handleExecuteShuffle,
  handleConfigureTeams,
  handleRemoveParticipants,
  handleClearParticipants,
  handleResetAssignments,
} from "./api";
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DEFAULT_TITLE } from "./db";
import * as fs from "fs";
import * as path from "path";

const cognitoClient = new CognitoIdentityProviderClient({});

/** このスタックが扱うイベントコード。単発イベント用に1つへ固定する。 */
const ALLOWED_EVENT_CODE = (process.env.EVENT_CODE || "JAWS-SAGA")
  .trim()
  .toUpperCase();

/**
 * NodejsFunction は esbuild の出力を /var/task 直下に置き、
 * commandHooks で public/ を同じ階層にコピーする。
 * ローカル実行 (dist/handler.js) では一つ上に public/ がある。
 */
const STATIC_DIR =
  process.env.STATIC_DIR ||
  [path.join(__dirname, "public"), path.join(__dirname, "..", "public")].find((p) =>
    fs.existsSync(p)
  ) ||
  path.join(__dirname, "public");

const TEXT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

const BINARY_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

/**
 * STATIC_DIR の外に出るパスを弾く。API Gateway は正規化してくれるが、
 * %2e%2e などで抜けられないよう自前でも確認する。
 */
function resolveStaticPath(relativePath: string): string | null {
  const candidate = path.resolve(STATIC_DIR, relativePath);
  const root = path.resolve(STATIC_DIR);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    return null;
  }
  return candidate;
}

function serveStatic(requestPath: string): APIGatewayProxyStructuredResultV2 {
  let relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");

  // /e/* は SPA ルーティングなので index.html を返す
  if (relativePath === "" || relativePath.startsWith("e/")) {
    relativePath = "index.html";
  }

  let filePath = resolveStaticPath(relativePath);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(STATIC_DIR, "index.html");
  }

  if (!fs.existsSync(filePath)) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "Not Found",
    };
  }

  const ext = path.extname(filePath).toLowerCase();
  const binaryType = BINARY_TYPES[ext];

  if (binaryType) {
    return {
      statusCode: 200,
      headers: { "Content-Type": binaryType, "Cache-Control": "public, max-age=300" },
      body: fs.readFileSync(filePath).toString("base64"),
      isBase64Encoded: true,
    };
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": TEXT_TYPES[ext] || "text/plain; charset=utf-8",
      // index.html はキャッシュさせない（デプロイ直後に古い画面が出るのを防ぐ）
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300",
    },
    body: fs.readFileSync(filePath, "utf-8"),
  };
}

async function toResult(res: Response): Promise<APIGatewayProxyStructuredResultV2> {
  const bodyText = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { statusCode: res.status, headers, body: bodyText };
}

async function handleLogin(rawBody: string): Promise<APIGatewayProxyStructuredResultV2> {
  const { email, password } = JSON.parse(rawBody || "{}");
  const clientId = process.env.USER_POOL_CLIENT_ID;

  if (!clientId) {
    return json(500, { error: "Cognito が未設定です（サーバ側の設定を確認してください）" });
  }

  try {
    const authResult = await cognitoClient.send(
      new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: clientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      })
    );

    if (authResult.ChallengeName) {
      // 恒久パスワードが設定されていれば起きないが、念のため理由を返す
      return json(401, {
        error: `追加の認証チャレンジが必要です (${authResult.ChallengeName})`,
      });
    }

    const idToken = authResult.AuthenticationResult?.IdToken;
    if (!idToken) {
      return json(401, { error: "ログインに失敗しました" });
    }

    return json(200, { token: idToken, user: { email } });
  } catch (err: any) {
    console.error("Cognito login failed:", err?.name, err?.message);

    // 全ての例外を同じ文言に潰すと、設定ミス（ユーザー未作成・認証フロー未許可）と
    // 単なるパスワード誤りが区別できず、当日に原因を追えなくなる。
    // 管理者1名だけの単発イベント用途なので、ユーザー列挙のリスクより
    // 診断できることを優先する。
    switch (err?.name) {
      case "UserNotFoundException":
        return json(401, {
          error:
            "このメールアドレスのユーザーが存在しません。デプロイ時の ADMIN_EMAIL と一致しているか確認してください。",
        });
      case "NotAuthorizedException":
        return json(401, { error: "パスワードが正しくありません" });
      case "PasswordResetRequiredException":
        return json(401, { error: "パスワードの再設定が必要です" });
      case "UserNotConfirmedException":
        return json(401, { error: "ユーザーが未確認の状態です" });
      case "InvalidParameterException":
        return json(500, {
          error:
            "Cognito の設定に問題があります（USER_PASSWORD_AUTH が有効か確認してください）",
        });
      default:
        return json(401, {
          error: `ログインに失敗しました (${err?.name || "UnknownError"})`,
        });
    }
  }
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const httpMethod = event.requestContext?.http?.method || "GET";
  const requestPath = event.rawPath || "/";
  const rawBody = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, "base64").toString("utf-8")
    : event.body || "";

  if (!requestPath.startsWith("/api/")) {
    return serveStatic(requestPath);
  }

  try {
    // API Gateway v2 のヘッダキーは小文字に正規化される
    const authHeader =
      event.headers?.authorization || event.headers?.["x-admin-token"] || null;

    if (requestPath === "/api/auth/login" && httpMethod === "POST") {
      return await handleLogin(rawBody);
    }

    if (requestPath === "/api/config" && httpMethod === "GET") {
      return json(200, {
        // フロントがイベントコードをハードコードしなくて済むよう返す。
        // デプロイ時に EVENT_CODE を変えても画面側の修正が要らない。
        eventCode: ALLOWED_EVENT_CODE,
        // タイトルも API から渡す。画面側に JAWS-UG 固定の文字列を残さない。
        title: DEFAULT_TITLE,
        userPoolId: process.env.USER_POOL_ID || "",
        userPoolClientId: process.env.USER_POOL_CLIENT_ID || "",
        appsyncHttpEndpoint: process.env.APPSYNC_HTTP_ENDPOINT || "",
        appsyncRealtimeEndpoint: process.env.APPSYNC_REALTIME_ENDPOINT || "",
        appsyncApiKey: process.env.APPSYNC_API_KEY || "",
        appsyncChannel: process.env.APPSYNC_CHANNEL || "/team-drawer/shuffle",
      });
    }

    // /api/events/{code}/...
    const segments = requestPath.replace(/^\/api\//, "").split("/").filter(Boolean);
    const eventCode = segments[1]
      ? decodeURIComponent(segments[1])
      : ALLOWED_EVENT_CODE;

    if (segments[0] === "events") {
      // 参加者登録は認証不要なので、任意のイベントコードを受け付けると
      // 誰でも無制限に DynamoDB アイテムを作れてしまう。
      // このスタックは単発イベント用なので、扱うコードを1つに固定する。
      if (eventCode.trim().toUpperCase() !== ALLOWED_EVENT_CODE) {
        return json(404, { error: "指定されたイベントは存在しません" });
      }

      if (segments.length <= 2 && httpMethod === "GET") {
        return await toResult(await handleGetEvent(eventCode));
      }

      if (segments.length === 3 && segments[2] === "participants" && httpMethod === "POST") {
        return await toResult(
          await handlePostParticipants(eventCode, JSON.parse(rawBody || "{}"))
        );
      }

      // 参加者が自分でくじを引く（管理者の操作は不要）
      if (segments.length === 3 && segments[2] === "draw" && httpMethod === "POST") {
        return await toResult(
          await handleDrawTeam(eventCode, JSON.parse(rawBody || "{}"))
        );
      }

      if (segments.length >= 3 && segments[2] === "admin" && httpMethod === "POST") {
        const action = segments[3];
        const body = JSON.parse(rawBody || "{}");

        if (action === "shuffle") {
          return await toResult(await handleExecuteShuffle(eventCode, authHeader, body));
        }
        if (action === "teams") {
          return await toResult(await handleConfigureTeams(eventCode, authHeader, body));
        }
        if (action === "remove-participants") {
          return await toResult(await handleRemoveParticipants(eventCode, authHeader, body));
        }
        if (action === "clear-participants") {
          return await toResult(await handleClearParticipants(eventCode, authHeader));
        }
        if (action === "reset") {
          return await toResult(await handleResetAssignments(eventCode, authHeader));
        }
      }
    }

    return json(404, { error: "API Endpoint Not Found" });
  } catch (err: any) {
    console.error("API Error:", err);
    return json(500, { error: err.message || "Internal Server Error" });
  }
}
