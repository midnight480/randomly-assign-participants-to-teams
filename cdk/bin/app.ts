import * as cdk from "aws-cdk-lib";
import { TeamDrawerStack } from "../lib/team-drawer-stack";

const app = new cdk.App();

// リージョンはここ 1 箇所で切り替える。
// 既定は ap-northeast-3 (Osaka)。AppSync Events 未提供などで deploy に失敗したら
//   APP_REGION=ap-northeast-1 npm run cdk:deploy
// で東京に切り替える。
const region =
  process.env.APP_REGION || app.node.tryGetContext("region") || "ap-northeast-3";

const adminEmail =
  process.env.ADMIN_EMAIL ||
  app.node.tryGetContext("adminEmail") ||
  "admin@jaws-ug-saga.example.com";

const adminPassword =
  process.env.ADMIN_PASSWORD || app.node.tryGetContext("adminPassword");

// イベントコード。URL（/e/{code}）とデータの保存キーになる。
// 変えると別イベント扱いになり、まっさらな状態から始まる。
const eventCode = String(
  process.env.EVENT_CODE || app.node.tryGetContext("eventCode") || "JAWS-SAGA"
)
  .trim()
  .toUpperCase();

if (!/^[A-Z0-9-]{1,32}$/.test(eventCode)) {
  throw new Error(
    `EVENT_CODE が不正です: "${eventCode}"\n` +
      "URL に入るため、英数字とハイフンのみ・32文字以内にしてください（例: JAWS-SAGA-2026）"
  );
}

// パスワード未設定なら例外を投げるのではなく、スタックを作らずに終える。
// `cdk bootstrap` もアプリを合成するため、ここで throw すると
// ブートストラップまで巻き添えで失敗してしまう。
// スタックが存在しなければ deploy は進めないので、安全性は保たれる。
if (!adminPassword) {
  console.error(
    [
      "",
      "管理者パスワードが未設定のため、スタックを生成しませんでした。",
      "リポジトリに平文で置かないよう環境変数で渡してください:",
      "",
      "  ADMIN_PASSWORD='YourStrongPassw0rd' npm run cdk:deploy",
      "",
      "条件: 8文字以上 / 大文字・小文字・数字をそれぞれ1文字以上",
      "使い回しではなく、このイベント専用の使い捨てパスワードにしてください。",
      "",
    ].join("\n")
  );
} else {
  // account は指定しない（アカウント非依存スタック）。
  // CDK_DEFAULT_ACCOUNT を要求すると、認証情報が解決できないときに
  // 「Unable to resolve AWS account to use」という原因の分かりにくい
  // エラーで止まる。account を省けばデプロイ時の認証情報から決まる。
  new TeamDrawerStack(app, "TeamDrawerStack", {
    env: { region },
    adminEmail,
    adminPassword,
    eventCode,
  });
}
