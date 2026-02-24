# ランダムチーム割り当て（くじ引き）Webサービス

参加者を任意のチーム数に割り当てる「くじ引き」サービス。  
Cloudflare Pages（静的配信）・Workers（API）・D1（SQLite）で構成。

## 機能

- **イベント単位**: URL に `event_code`（例: `/e/SA2026`）で会場共有
- **チームパターン**: 4チーム [4,4,5,5] や 5チーム [3,3,4,4,4] などを指定
- **参加者フロー**: 表示名入力 → 「くじを引く」→ Team 確定（二重送信・同名対策あり）
- **公平な割り当て**: 空き枠からランダムに 1 枠を割り当て
- **リセット**: 運営向けに「割り当てのみリセット」「参加者・割り当てを全削除」（管理者トークン必須）
- **状況表示**: チームごとのメンバー一覧・残り枠

## 技術スタック

- **フロント**: Vanilla JS + HTML/CSS（`public/`）
- **API**: Cloudflare Workers（`src/`）
- **DB**: Cloudflare D1（SQLite 互換）
- **配信**: Workers + Assets（同一オリジンで API と静的を提供）

## セットアップ

### 1. 依存関係

```bash
npm install
```

### 2. D1 データベース作成

```bash
npx wrangler d1 create random-team-drawer-db
```

表示された `database_id` を `wrangler.toml` の `[[d1_databases]]` の `database_id` に設定してください。

### 3. 管理者トークンのハッシュを seed に反映

seed で使う管理者トークン（例: `sagachoiraku`）の SHA-256 を生成し、`migrations/seed.sql` の `admin_token_hash` をその値に置き換えます。

```bash
# デフォルトは sagachoiraku
node scripts/gen-seed-hash.js

# 任意のトークン
ADMIN_TOKEN=your-secret node scripts/gen-seed-hash.js
```

表示された SHA-256 で `seed.sql` 内の `'a3f5e6b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8'` を一括置換してください。

### 4. マイグレーションとシード（ローカル）

```bash
npm run db:migrate:local
npm run db:seed:local
```

### 5. ローカル実行

```bash
npm run dev
```

ブラウザで `http://localhost:8787/e/SA2026` を開き、表示名を入れて「くじを引く」を試せます。  
管理画面は `http://localhost:8787/e/SA2026/admin`（管理者トークンは seed で設定した値）。

## デプロイ

カスタムドメインは使用せず、デプロイ後は `https://random-team-drawer.<あなたのサブドメイン>.workers.dev` でアクセスします。

### 本番用 D1 を作成する場合

```bash
npx wrangler d1 create random-team-drawer-db-prod
```

`wrangler.toml` の `database_id` を本番用 ID に変更するか、`[env.production]` で上書きしてください。

```bash
npm run db:migrate
npm run db:seed
npm run deploy
```

## API 概要

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/events/:event_code` | イベント情報・チーム状況・残枠 |
| POST | `/api/events/:event_code/participants` | 参加者登録（body: `{ display_name }`） |
| POST | `/api/events/:event_code/draw` | くじを引く（body: `{ display_name }`） |
| PATCH | `/api/events/:event_code` | イベント名・チーム構成の変更（Header: `X-Admin-Token`、body: `{ title?, pattern: { teams } }`） |
| POST | `/api/events/:event_code/admin/reset-assignments` | 割り当てのみリセット（Header: `X-Admin-Token`） |
| POST | `/api/events/:event_code/admin/reset-all` | 参加者・割り当てを全削除（Header: `X-Admin-Token`） |

## 追加機能（当日運用強化）

- **くじ演出**: 抽選中スロット風表示（1.2〜2秒）、振動、結果は「決定！」＋大きめ表示
- **入力アシスト**: プレースホルダー、全角/半角トリム・連続スペース縮約、30文字上限
- **同名**: 方針A — 同名は登録不可（409）、「名字やニックネームを足してください」と案内
- **管理画面**: イベント名・チーム数・チーム構成の変更（プリセット 4/5チーム or カスタム「4,4,5,5」）、トークンは sessionStorage に保持、リセットは二段階確認、成功時トースト
- **進行共有**: 参加画面 3秒ポーリング、管理画面 2秒ポーリングで状況更新
- **会場表示モード** `/e/:event_code/display`: チーム一覧・残り枠・参加URLのQRコード（TV/プロジェクター用）、2秒ポーリング

## 受け入れ条件チェックリスト

- [x] 参加者が自分で名前入力 → くじ → チーム確定
- [x] 18名で 4,4,5,5 または 3,3,4,4,4 が満たされる
- [x] 割り当てリセット / 完全リセットができる
- [x] 同名・連打・二重送信で破綻しない（同名は 409 で案内、冪等で既存割当を返す）
- [x] 状況一覧が表示される
- [x] 抽選演出（スロット風・振動・決定表示）
- [x] 二重送信防止（演出中ボタン無効）
- [x] 管理者二段階確認・トースト・トークン保持
- [x] 状況の自動更新（ポーリング）

## ディレクトリ構成

```
├── public/           # 静的ファイル（HTML, CSS, JS）
├── src/              # Worker（API ルーティング・D1 操作）
├── migrations/       # D1 マイグレーション
├── seed.sql         # 初期データ（要 admin_token_hash 置換）
├── scripts/          # 開発用スクリプト
├── wrangler.toml
└── package.json
```

## 簡易テスト（手動）

1. **GET イベント**: `curl -s http://localhost:8787/api/events/SA2026` → event_code, teams, remaining_slots が返る
2. **POST くじ**: `curl -s -X POST http://localhost:8787/api/events/SA2026/draw -H "Content-Type: application/json" -d '{"display_name":"テスト"}'` → team_name が返る
3. **同名**: 同じ display_name で再度 draw → 同じ team_name（冪等）。participants を同名で登録 → 409 とメッセージ
4. **リセット**: 管理画面でトークン入力 → 割り当てリセット → トースト表示。完全リセットは二段階で「RESET」入力
5. **会場表示**: `/e/SA2026/display` で QR・チーム一覧・2秒更新が表示される

## ライセンス

MIT
