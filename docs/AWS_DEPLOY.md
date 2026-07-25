# AWS デプロイ手順（AWS-Optimize ブランチ）

JAWS-UG佐賀 ワークショップ用。管理者がシャッフルを実行し、参加者は公開URLで結果を閲覧する。

## 構成

| 役割 | サービス |
|---|---|
| 画面配信 + API | API Gateway HTTP API (`$default` ステージ) → Lambda |
| データ保存 | DynamoDB（1イベント = 1アイテム） |
| 管理者認証 | Cognito User Pool（USER_PASSWORD_AUTH） |
| リアルタイム更新 | AppSync Events（チャンネル `/team-drawer/shuffle`） |

チーム分けアルゴリズムと佐賀弁チーム名（`src/api.ts` の `SAGA_WORDS` / `pickRandomSagaNames`）は元のまま。

## 前提

- Node.js 20 以上
- AWS 認証情報が設定済み（`aws sts get-caller-identity` が通ること）
- 対象リージョンで CDK ブートストラップ済み

```bash
npm install
npx cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-3
```

## デプロイ

管理者パスワードは環境変数で渡す（リポジトリに平文で置かない）。

```bash
ADMIN_PASSWORD='YourStrongPassw0rd' \
ADMIN_EMAIL='admin@example.com' \
npm run cdk:deploy
```

パスワード要件: 8文字以上／大文字・小文字・数字をそれぞれ1文字以上。

デプロイ完了後、`ParticipantUrl` と `AdminUrl` が出力される。

## リージョンの切り替え

既定は **ap-northeast-3 (Osaka)**。AppSync Events が未提供などで失敗した場合は東京へ:

```bash
APP_REGION=ap-northeast-1 ADMIN_PASSWORD='...' npm run cdk:deploy
```

切り替え箇所は `cdk/bin/app.ts` の `region` のみ。

## 撤収

```bash
npm run cdk:destroy
# 別リージョンに残っている場合
APP_REGION=us-east-1 npm run cdk:destroy
```

## 設計メモ

- **DynamoDB を使う理由**: Lambda の `/tmp` は実行環境ごとに独立しており、複数コンテナに分散すると管理者が書いた結果を参加者が読めない。当日は参加者が一斉アクセスするため確実に分散する。
- **HTTP API を使う理由**: REST API は URL が `/prod/...` になり、フロントの絶対パス（`/api/...`, `/styles.css`）が届かなくなる。`$default` ステージならパスにステージ名が入らない。
- **Cognito の恒久パスワード**: `CfnUserPoolUser` だけでは `FORCE_CHANGE_PASSWORD` のままログインできないため、`AwsCustomResource` で `AdminSetUserPassword` を実行している。
- **AppSync Events のフォールバック**: 参加者画面は WebSocket 購読に加えて 3 秒ポーリングも併用しているため、リアルタイム通知が落ちても結果は反映される。
