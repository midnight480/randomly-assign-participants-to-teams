/**
 * ローカル開発用サーバ。本番と同じ src/server.ts を PORT で待ち受けさせる。
 * デプロイせずにブラウザで画面を確認するためのもの。
 *
 *   ./scripts/dev.sh
 *
 * 管理者操作(shuffle / reset)は Cognito 検証を通らないため 401 になる。
 * 画面確認用のデータは scripts/seed-local.ts で直接 DynamoDB Local に入れる。
 */
import { createServer } from "../src/server";

const PORT = Number(process.env.PORT || 3000);

createServer().listen(PORT, () => {
  const code = (process.env.EVENT_CODE || "JAWS-SAGA").trim().toUpperCase();
  console.log(`dev server: http://localhost:${PORT}/e/${code}`);
  console.log(`admin      : http://localhost:${PORT}/e/${code}/admin`);
});
