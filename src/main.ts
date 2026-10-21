/**
 * Lambda Web Functions のエントリポイント（バンドル後の index.js）。
 * ランタイムは自前の起動処理からこのファイルを読み込むため、
 * require.main === module では判定できない。読み込まれたら必ず listen する。
 */
import { createServer } from "./server";

// Lambda は待ち受け先を AWS_LAMBDA_HTTP_ENDPOINT（host:port）で渡してくる。
// 起動から10秒以内に listen しないと初期化失敗になる。
const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || "localhost:3000").split(":");
const server = createServer();
server.listen(Number(port), host, () => {
  console.log(`listening on ${host}:${port}`);
});

// 実行環境を回収するときは SIGTERM が来る。処理中のリクエストを返し切ってから終える
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
