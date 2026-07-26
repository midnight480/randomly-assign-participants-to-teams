/**
 * ローカル開発用サーバ。Lambda ハンドラをそのまま HTTP で叩けるようにする。
 * デプロイせずにブラウザで画面を確認するためのもので、本番では使わない。
 *
 *   ./scripts/dev.sh
 *
 * 管理者操作(shuffle / reset)は Cognito 検証を通らないため 401 になる。
 * 画面確認用のデータは scripts/seed-local.ts で直接 DynamoDB Local に入れる。
 */
import * as http from "http";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "../src/handler";

const PORT = Number(process.env.PORT || 3000);

function toEvent(
  req: http.IncomingMessage,
  body: string
): APIGatewayProxyEventV2 {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers[k.toLowerCase()] = v;
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
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: headers["user-agent"] || "",
      },
    },
    body: body || undefined,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf-8");
    try {
      const result = await handler(toEvent(req, body));
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
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`dev server: http://localhost:${PORT}/e/JAWS-SAGA`);
  console.log(`admin      : http://localhost:${PORT}/e/JAWS-SAGA/admin`);
});
