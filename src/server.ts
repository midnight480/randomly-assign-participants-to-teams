/**
 * Lambda Web Functions 用の HTTP サーバ。
 * Web Functions はポートで待ち受ける普通の HTTP サーバを起動する仕組みなので、
 * リクエストを API Gateway v2 のイベント形式に詰め替えて既存の handler に渡す。
 * ルーティングや認証の処理は handler.ts に1本化したまま変えない。
 *
 * 起動は src/main.ts で行う。ローカル開発用の scripts/dev-server.ts も、このサーバを使う。
 */
import * as http from "http";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "./handler";

function toEvent(req: http.IncomingMessage, body: Buffer): APIGatewayProxyEventV2 {
  // パスとクエリだけ使うので、ホスト名は何でもよい
  const url = new URL(req.url || "/", "http://localhost");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers[k.toLowerCase()] = v;
    else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(",");
  }

  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ""),
    headers,
    requestContext: {
      http: {
        method: req.method || "GET",
        path: url.pathname,
        protocol: `HTTP/${req.httpVersion}`,
        sourceIp: req.socket.remoteAddress || "",
        userAgent: headers["user-agent"] || "",
      },
    },
    body: body.length ? body.toString("utf-8") : undefined,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

export function createServer(): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        const result = await handler(toEvent(req, Buffer.concat(chunks)));
        const headers = (result.headers || {}) as Record<string, string>;
        res.writeHead(result.statusCode || 200, headers);
        res.end(
          result.isBase64Encoded
            ? Buffer.from(result.body || "", "base64")
            : result.body || ""
        );
      } catch (err) {
        console.error(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    });
  });
}
