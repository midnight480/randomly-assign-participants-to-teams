# Antigravity (AGY) セキュリティ＆ソースコードレビュー報告書

本ドキュメントは、`AWS-Optimize` ブランチにおけるチーム分けアプリケーション (`randomly-assign-participants-to-teams`) のソースコードおよび AWS インフラ定義 (`docs/AWS_DEPLOY.md` に記載された修正内容含む) に対する詳細セキュリティ・品質レビュー結果をまとめたものです。

---

## 概要

| 項目 | 評価 | 備考 |
|---|---|---|
| **総合評価** | 🟢 **合格 (ワークショップ運用可能)** | セキュリティ、耐久性、パフォーマンスの観点で十分に考慮されています |
| **自動テスト** | ✅ **35件パス (100%)** | 振り分けロジック、DynamoDB連携、認証ガード、パストラバーサル検証含む |
| **型チェック** | ✅ **TS コンパイル成功** | `npm run typecheck` エラーなし |
| **CDK Synth** | ✅ **正常完了** | 大阪リージョン (ap-northeast-3) テンプレート生成確認済み |

---

## セキュリティリスク・懸念点および対策状況

### 1. 🔑 認証・認可 (Cognito & JWT)

#### 判定: 🟢 低リスク（対策済み）
- **fail-closed 構造の徹底**: `src/auth.ts` の `verifyAdminToken()` は、Cognito ユーザープール未設定時やトークン異常時、ヘッダ欠落時に必ず `false` を返し、`401 Unauthorized` を出力します。
- **Cognito Self Sign-Up の無効化**: `cdk/lib/team-drawer-stack.ts` にて `selfSignUpEnabled: false` が明示されており、部外者が勝手に管理者ユーザーを登録するリスクを防止しています。
- **恒久パスワードの初回自動設定**: `AwsCustomResource` で `adminSetUserPassword(Permanent: true)` を実行しており、CDK デプロイ直後に Cognito 特有の `FORCE_CHANGE_PASSWORD` ログイン不能トラップに陥らないよう配慮されています。

### 2. 🛡️ CloudFormation 内のパスワード平文記録リスク

#### 判定: 🟡 注意（単発イベントとしては許容可）
- **内容**: `cdk/lib/team-drawer-stack.ts` 内の `AwsCustomResource`（`SetAdminPassword`）のパラメータとして `adminPassword` をそのまま渡しています。
- **リスク**: CloudFormation のスタック履歴および CloudTrail のイベントログに、設定した管理者パスワードが平文テキストとして記録されます。
- **推奨対策（本番環境向け）**: ワークショップ単発用としては運用上問題ありませんが、長期運用・本番運用の場合は AWS Secrets Manager や Parameter Store を経由してパスワードを設定する構成が推奨されます。

### 3. 📡 AppSync Events APIキー公開と第三者パブリッシュのリスク

#### 判定: 🟢 低リスク（フロントエンド側で影響緩和済み）
- **内容**: 参加者画面がリアルタイム購読するために、`/api/config` エンドポイント経由で AppSync の API キーを公開しています。そのため、悪意ある第三者が API キーを入手して直接 AppSync チャンネルに偽イベントを publish できます。
- **評価＆対策状況**:
  1. **データの信頼性**: 参加者画面 (`public/app.js`) は AppSync からデータを受信した際、そのペイロードを直接画面に反映するのではなく、必ずサーバーの正規 API (`/api/events/{code}`) から最新状態を再取得しています。そのため偽データが表示されることはありません。
  2. **DDoS / バックエンド連打対策**: `public/app.js` 内の `setupAppSyncRealtime()` にて、イベント受信時の API 再取得を 1 秒に 1 回までに制限するスロットル (`throttledUpdate`) が実装されています。

### 4. 🗄️ DynamoDB アイテムサイズ上限 & リソース枯渇 (DoS) 対策

#### 判定: 🟢 低リスク（対策済み）
- **内容**: 参加者自己登録機能 (`POST /api/events/{code}/participants`) が無認証で開示されているため、大量登録によって DynamoDB の 1 アイテム上限 (400KB) に達し、状態が破損するリスクがありました。
- **対策状況**: `src/api.ts` の `MAX_PARTICIPANTS` 定数により、**最大500名**の登録・シャッフル上限を厳密にチェックし、超える場合は全件拒否（400 Bad Request）する防御ロジックが組み込まれています。

### 5. 💻 フロントエンド安全対策 (XSS & パストラバーサル)

#### 判定: 🟢 低リスク（対策済み）
- **XSS 対策**: `public/app.js` 全域で、参加者名・チーム名・コメント出力時に `escapeHtml()` を適用して HTML エスケープを行っています。
- **パストラバーサル対策**: `src/handler.ts` の `resolveStaticPath()` にて、`path.resolve()` による境界チェックを実施。`../` や `%2e%2e` 等による静的配信ディレクトリ外のファイル閲覧をブロックしており、テストコード (`test/handler.test.ts`) でも検証済みです。

---

## 既存ロジック・要件の適合確認

| 要件 | 適合状況 | 実装詳細 |
|---|---|---|
| **チーム分けアルゴリズム** | 保持 | `src/api.ts` の `buildTeams()` に抽出。Fisher-Yates シャッフルおよび均等割り当てロジックを一切変えずに維持。 |
| **佐賀弁チーム名・コメント** | 保持 | `SAGA_WORDS` および `generateTeamComments()` により、味のある佐賀弁チーム名とコメントを自動付与。 |
| **リアルタイム同期** | 保持 | AppSync Events WebSocket 接続 ＋ 3秒ポーリングのフォールバック機構を併用。 |
| **一元化デプロイ** | 保持 | `cdk deploy` のみで API Gateway, Lambda, DynamoDB, Cognito, AppSync が一発構築可能。 |

---

## 運用上の推奨・注意事項

1. **AWS アクセスキーの取り扱い**:
   - チャットや設定ファイル等に渡された開発用 AWS アクセスキーは、デプロイ検証完了後に速やかに無効化・削除してください。
2. **リージョン切り替え**:
   - 大阪リージョン (`ap-northeast-3`) で AppSync Events が利用できない場合、`APP_REGION=ap-northeast-1 npm run cdk:deploy` で東京リージョンへ切り替えてデプロイを行ってください。
