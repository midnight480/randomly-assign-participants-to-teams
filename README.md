# ランダムチーム割り当て（くじ引き）Webサービス — AWS 版

参加者を任意のチーム数にランダム振り分けする「くじ引き」サービス。
JAWS-UG佐賀 ワークショップ向けに、**管理者がシャッフルを実行 → 参加者は公開URLで結果を閲覧**する構成。

> このブランチ（`AWS-Optimize`）は AWS 上で動く構成です。
> Cloudflare Workers / D1 版は `main` ブランチを参照してください。

## 機能

- **管理画面**（Cognito 認証必須 / `/e/{code}/admin`）
  - 参加者名を改行区切りでまとめて入力
  - チーム数を指定してシャッフル実行
  - 佐賀弁のチーム名（がばい・そいぎ・やーらしか …）を自動採番
  - チームごとに佐賀弁のひとことコメントを付与
  - 割り当てのリセット
- **参加者向け画面**（認証不要 / `/e/{code}`）
  - 直近のチーム分け結果とコメントを表示
  - AppSync Events でリアルタイム反映（3秒ポーリングを併用したフォールバックあり）

## 構成

| 役割 | サービス |
|---|---|
| 画面配信 + API | API Gateway HTTP API（`$default` ステージ）→ Lambda |
| データ保存 | DynamoDB（1イベント = 1アイテム） |
| 管理者認証 | Cognito User Pool（`USER_PASSWORD_AUTH`） |
| リアルタイム更新 | AppSync Events（チャンネル `/team-drawer/shuffle`） |
| IaC | AWS CDK |

## セットアップ

```bash
npm install
npx cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-3   # 初回のみ
```

## デプロイ

管理者パスワードは環境変数で渡します（リポジトリに平文で置かないため）。
**必ず使い捨てのパスワードを使ってください**。指定した値は CloudFormation
テンプレートに平文で残ります（詳細は `docs/AWS_DEPLOY.md`）。

```bash
ADMIN_PASSWORD='YourStrongPassw0rd' \
ADMIN_EMAIL='admin@example.com' \
npm run cdk:deploy
```

完了後、`ParticipantUrl` と `AdminUrl` が出力されます。

リージョン既定は **ap-northeast-3 (Osaka)**。切り替えは `APP_REGION` のみ:

```bash
APP_REGION=ap-northeast-1 ADMIN_PASSWORD='...' npm run cdk:deploy
```

詳細な手順・設計判断・実装ログは [`docs/AWS_DEPLOY.md`](docs/AWS_DEPLOY.md) を参照。

## テスト

```bash
npm test        # 単体 + DynamoDB Local を使った統合テスト（Docker 必要）
npm run typecheck
```

Docker が無い環境では、純粋ロジックの単体テストのみ実行されます。

## ローカルで画面を確認する

デプロイせずにブラウザで動作を確認できます（Docker 必要）。

```bash
./scripts/dev.sh   # http://localhost:3000/e/JAWS-SAGA
```

DynamoDB Local を起動し、サンプルのチーム分け結果を入れた状態でサーバが立ちます。
Cognito はローカルに無いため、管理者操作（シャッフル・リセット）は 401 になります。

## API 概要

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| GET | `/api/config` | 不要 | フロント用の設定値（Cognito / AppSync） |
| POST | `/api/auth/login` | 不要 | Cognito ログイン（ID トークンを返す） |
| GET | `/api/events/{code}` | 不要 | チーム分け結果・参加者一覧 |
| POST | `/api/events/{code}/participants` | 不要 | 参加者登録（body: `{ names: string[] }`） |
| POST | `/api/events/{code}/admin/shuffle` | 必要 | シャッフル実行（`Authorization: Bearer <IDトークン>`） |
| POST | `/api/events/{code}/admin/reset` | 必要 | 割り当てリセット |

## ディレクトリ構成

```
├── public/           # 静的ファイル（HTML, CSS, JS）
├── src/              # Lambda（API ルーティング・DynamoDB 操作・認証）
│   ├── handler.ts    #   エントリポイント（ルーティング / 静的配信）
│   ├── api.ts        #   チーム分けロジック・エンドポイント実装
│   ├── db.ts         #   DynamoDB アクセス
│   ├── auth.ts       #   Cognito ID トークン検証
│   ├── comments.ts   #   佐賀弁ひとことコメント
│   └── events.ts     #   AppSync Events publish
├── cdk/              # CDK スタック定義
├── test/             # テスト
├── scripts/          # 開発用スクリプト
└── docs/             # 仕様・デプロイ手順・実装ログ
```

## ライセンス

MIT
