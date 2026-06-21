# 機能仕様 (FUNCTIONS.md)

参加者をチームにランダム振り分けする「くじ引き」Webサービスの **機能仕様** を、特定プラットフォーム（Cloudflare Workers / D1）に依存しない形で定義する。

このドキュメントは以下を目的とする。

- 現行機能の網羅的な整理（移植・再実装の基準）
- Vercel / Netlify など別プラットフォームへ移植する際の「変えてはいけない仕様」と「差し替え可能な実装」の切り分け
- デザイン刷新（→ [DESIGNS.md](./DESIGNS.md)）と独立して機能を維持するための参照仕様

---

## 1. 概要

| 項目 | 内容 |
|------|------|
| サービス名 | ランダムチーム割り当て（くじ引き）Webサービス |
| 想定利用シーン | イベント・ワークショップ・アイディアソン等の会場で、参加者を複数チームに公平にランダム振り分けする |
| 利用者の種類 | 参加者（自分でくじを引く） / 運営・管理者（設定・リセット） / 会場ディスプレイ（TV・プロジェクター表示） |
| 基本単位 | **イベント（event）**。`event_code` で識別し、URL で共有する |
| 言語 / ロケール | 日本語（UI文言・チーム名は佐賀弁の文化語彙をデフォルト採用） |

### 1.1 アーキテクチャの抽象モデル（プラットフォーム非依存）

```
[ブラウザ SPA] ── HTTP(JSON) ──> [API レイヤ] ──> [永続ストレージ(RDB)]
   静的配信         /api/*           ルーティング+業務ロジック    events/participants/assignments
```

- **静的配信**: SPA（HTML/CSS/JS）を配信。SPA ルーティングのため、未知パスは `index.html` にフォールバックする。
- **API レイヤ**: `/api/*` を処理する関数群。HTTP メソッド + パスでルーティング。
- **永続ストレージ**: リレーショナルDB。SQLite 互換（D1）を現行採用しているが、機能的には Postgres / MySQL / SQLite いずれでも成立する（後述スキーマ参照）。

> 移植の指針: 「API レイヤ」と「永続ストレージ」の差し替えが移植作業の中心。SPA とエンドポイント仕様（§4）・データモデル（§3）・業務ルール（§5）は不変とする。

---

## 2. ロール別の利用フロー

URL のパス構造でロール（モード）を切り替える。SPA 側ルーティングは正規表現 `^/e/([^/]+)(?:/(admin|display))?/?$` で解釈する。

| ロール | URL | 説明 |
|--------|-----|------|
| 参加者 | `/e/:event_code` | くじを引く。チーム一覧・残り枠を閲覧 |
| 管理者 | `/e/:event_code/admin` | イベント名・チーム構成の設定、チーム名再生成、リセット |
| 会場表示 | `/e/:event_code/display` | チーム一覧・残り枠・参加用QRコードを大画面表示 |
| トップ | `/` | 案内のみ（イベントコードをURLで開くよう促す） |

### 2.1 参加者フロー

1. `/e/:event_code` を開く（QR/URL 共有経由）。
2. イベント情報を取得し、タイトル・進捗（参加済み/総枠・残り枠）・チーム一覧を表示。
3. 表示名（氏名・ニックネーム）を入力。
4. 「くじを引く」を押す → 抽選演出 → チーム確定を表示。
5. 一度引いた名前は端末（localStorage）に保存され、再訪時は自動で既存の割り当て結果を再表示する（冪等。再抽選はしない）。

### 2.2 管理者フロー

1. `/e/:event_code/admin` を開く。
2. 管理者トークンを入力（セッション中は sessionStorage に保持）。
3. 以下を操作:
   - イベント名の変更
   - チーム数・総枠の指定（均等配分を自動計算）
   - チーム構成のプリセット選択 or カスタム入力（例 `4,4,5,5`）
   - チーム名の再生成（割り当て0人のときのみ）
   - 割り当てのみリセット / 参加者・割り当て全削除（いずれも二段階確認）

### 2.3 会場表示フロー

1. `/e/:event_code/display` を開く。
2. 参加用URLのQRコード、進捗、チーム一覧を大画面向けに表示。
3. 一定間隔でポーリングし最新化。

---

## 3. データモデル

リレーショナルDB。3テーブル構成。SQLite 表記だが型は各DBへ読み替え可能。

### 3.1 events（イベント）

| カラム | 型 | 制約 | 説明 |
|--------|----|------|------|
| id | INTEGER | PK, AUTOINCREMENT | 内部ID |
| event_code | TEXT | NOT NULL, UNIQUE | イベント識別コード（URL で使用、大文字に正規化） |
| title | TEXT | NOT NULL DEFAULT '' | イベント名 |
| pattern_json | TEXT | NOT NULL | チーム構成 JSON（§3.4） |
| admin_token_hash | TEXT | NOT NULL | 管理者トークンの SHA-256 ハッシュ（平文は保存しない） |
| created_at | TEXT | NOT NULL DEFAULT now | 作成日時 |

- インデックス: `event_code`

### 3.2 participants（参加者）

| カラム | 型 | 制約 | 説明 |
|--------|----|------|------|
| id | INTEGER | PK, AUTOINCREMENT | 内部ID |
| event_id | INTEGER | NOT NULL, FK→events(id) ON DELETE CASCADE | 所属イベント |
| display_name | TEXT | NOT NULL | 表示名 |
| created_at | TEXT | NOT NULL DEFAULT now | 登録日時 |

- 一意制約: `UNIQUE(event_id, display_name)` … **同一イベント内で表示名は一意**
- インデックス: `event_id`

### 3.3 assignments（割り当て）

| カラム | 型 | 制約 | 説明 |
|--------|----|------|------|
| id | INTEGER | PK, AUTOINCREMENT | 内部ID |
| event_id | INTEGER | NOT NULL, FK→events(id) ON DELETE CASCADE | 所属イベント |
| participant_id | INTEGER | NOT NULL, FK→participants(id) ON DELETE CASCADE | 参加者 |
| team_name | TEXT | NOT NULL | 割り当て先チーム名 |
| assigned_at | TEXT | NOT NULL DEFAULT now | 割り当て日時 |

- 一意制約: `UNIQUE(event_id, participant_id)` … **1参加者につき1チームのみ**（冪等性の要）
- インデックス: `event_id`, `(event_id, team_name)`

### 3.4 チーム構成 JSON（pattern_json / EventPattern）

```json
{ "teams": [ { "name": "がばい", "size": 4 }, { "name": "ぼちぼち", "size": 4 } ] }
```

- `teams[].name`: チーム名（文字列）
- `teams[].size`: そのチームの定員（正の整数）
- チーム名は `events.pattern_json` 内に保持され、`assignments.team_name` は名前文字列で参照する（名前変更時の整合性に注意 → §5.5）。

---

## 4. API 仕様（エンドポイント）

ベースパス `/api`。リクエスト/レスポンスはいずれも JSON。レスポンスは `Cache-Control: no-store`。エラーは `{ "error": "メッセージ" }` 形式 + 対応する HTTP ステータス。

| メソッド | パス | 認証 | 説明 |
|---------|------|------|------|
| GET | `/api/events/:event_code` | 不要 | イベント情報・チーム状況・残枠を取得 |
| POST | `/api/events/:event_code/participants` | 不要 | 参加者登録のみ（抽選しない） |
| POST | `/api/events/:event_code/draw` | 不要 | くじを引く（登録 + 抽選、冪等） |
| PATCH | `/api/events/:event_code` | **管理** | イベント名・チーム構成を更新 |
| POST | `/api/events/:event_code/admin/reset-assignments` | **管理** | 割り当てのみリセット |
| POST | `/api/events/:event_code/admin/reset-all` | **管理** | 参加者・割り当てを全削除 |
| POST | `/api/events/:event_code/admin/regenerate-team-names` | **管理** | チーム名を再生成（割り当て0人時のみ） |

### 4.1 認証（管理操作）

- ヘッダ `X-Admin-Token` に管理者トークンを送る。
- クライアントは UTF-8 → base64 でエンコードして送る（`btoa(unescape(encodeURIComponent(token)))`）。サーバは base64 デコードを試み、失敗時は生文字列として扱う。
- サーバはトークンを SHA-256 ハッシュ化し、`events.admin_token_hash` と一致照合する。
- 認証失敗: トークン未指定→401、不一致→403。

### 4.2 `GET /api/events/:event_code`

レスポンス例:

```json
{
  "event_code": "SA2026",
  "title": "ちょいラク未来デザイン アイディアソン",
  "pattern": { "teams": [ { "name": "がばい", "size": 4 } ] },
  "teams": [
    { "name": "がばい", "size": 4, "assigned": 2, "remaining": 2, "members": ["佐賀太郎", "しばお"] }
  ],
  "total_slots": 18,
  "assigned_count": 2,
  "unassigned_count": 0,
  "remaining_slots": 16
}
```

- `total_slots`: 全チームの定員合計
- `assigned_count`: 割り当て済み人数
- `remaining_slots`: `total_slots - assigned_count`
- `unassigned_count`: 参加者総数 − 割り当て済み（draw を使う限り通常 0。participants 直接登録時に発生しうる）
- `event_code` が見つからない→404、`pattern_json` が壊れている→500。

### 4.3 `POST /api/events/:event_code/participants`

- body: `{ "display_name": string }`
- 表示名を正規化（§5.1）して登録。
- 成功: `{ participant_id, display_name, created_at }`
- 同名既存: 409 「同じ名前の参加者が既に登録されています。…」
- 表示名空: 400 / イベントなし: 404

### 4.4 `POST /api/events/:event_code/draw`（中核）

- body: `{ "display_name": string }`
- 動作:
  1. 表示名を正規化。
  2. 参加者を取得 or 登録（同名は既存IDを再利用 = 冪等）。
  3. 既に割り当て済みなら、その結果を `already_assigned: true` で返す（**再抽選しない**）。
  4. 未割り当てなら、空き枠から重み付きランダムで1チームを選び割り当て。
- 成功: `{ display_name, team_name, assigned_at, already_assigned }`
- 空き枠なし: 409 「チームの空き枠がありません」
- 競合（UNIQUE 衝突）時は最大3回までリトライ。最終的に失敗→500。

### 4.5 `PATCH /api/events/:event_code`（管理）

- body: `{ "title"?: string, "pattern"?: { "teams": [ { "name"?: string, "size": number } ] } }`
- `title`: trim + 200文字上限。
- `pattern.teams`: §5.5 の制約に従い検証・更新。
- 成功: `{ message, title, pattern }`

### 4.6 リセット系（管理）

- `reset-assignments`: 当該イベントの assignments を全削除。participants は残す。
- `reset-all`: 当該イベントの assignments と participants を全削除。
- 成功: `{ message }`

### 4.7 `POST /api/events/:event_code/admin/regenerate-team-names`（管理）

- 割り当てが1人以上ある場合は 400 で拒否。
- 割り当て0人時のみ、チーム数ぶんの新チーム名を重複なしで再生成し pattern を更新。
- 成功: `{ message, pattern }`

---

## 5. 業務ルール（不変仕様）

移植・再実装時に **必ず維持すべき** ロジック。

### 5.1 表示名の正規化

- 前後空白除去、連続空白を1つに圧縮、**30文字上限**。
- クライアント・サーバ双方で同一処理（`trim → \s+→空白1つ → slice(0,30)`）。
- 空文字になった場合はエラー。

### 5.2 event_code の正規化

- `trim` + **大文字化**（`toUpperCase`）して照合。URL 上の大小は区別しない。

### 5.3 抽選アルゴリズム（公平性）

- 空き枠のあるチームのみを候補とする。
- 各チームの「残り枠数」を重みにした **加重ランダム抽選**（残り枠が多いチームほど選ばれやすい）。
  - これにより全体として各チームが均等に埋まる方向へ収束する。
- 実装: 残り枠合計を `R` とし、`floor(random()*R)` を残り枠で順に減算して当選チームを決定。

### 5.4 冪等性・二重送信耐性（重要）

- 同一 `(event_id, display_name)` は1参加者に集約（participants の UNIQUE）。
- 同一参加者は1チームのみ（assignments の UNIQUE）。
- draw は「既割り当てなら既存結果を返す」ため、連打・再送・再訪で結果が変わらない。
- UNIQUE 衝突は捕捉し、既存レコードを引いて正常応答に変換（最大3リトライ）。
- フロントは抽選演出中ボタンを無効化し、二重送信を抑止。

### 5.5 チーム構成変更時の整合性（PATCH）

割り当て状況に応じて制約が変わる。

**割り当てがある場合（assignedTotal > 0）:**
- 総枠 `<` 割り当て済み総数 → 400。
- 割り当て済みのチームを削除しようとする → 400。
- あるチームの新 `size` `<` そのチームの割り当て済み人数 → 400。
- 名前未指定のチームを含む変更は不可（名前変更でメンバー参照が壊れるため）→ 400。

**割り当てが0の場合:**
- 名前が空のチームには、未使用のデフォルト語彙（佐賀弁）から重複なしで自動命名する。
- 語彙が不足する場合は 400。

- チーム数の上限はデフォルト語彙数（現在30語）に従う。

### 5.6 チーム名の語彙（デフォルト）

- 佐賀弁の文化語彙（場所・団体・企業・人物を指さない一般語）30語をプールとして保持。
- 自動命名・再生成時に、重複なしでランダム抽出（Fisher–Yates シャッフル）。
- この語彙は **設定可能な定数** として扱い、地域・テーマに応じて差し替え可能とする（移植時の差別化ポイント）。

---

## 6. フロントエンド機能（SPA 挙動）

クライアントサイドのみで完結する挙動（API 仕様と独立）。

| 機能 | 内容 |
|------|------|
| ルーティング | パス正規表現でロール判定。SPA フォールバック前提 |
| 抽選演出 | スロット風表示（1.2〜2.0秒、80ms ごとにチーム名を切替）、結果は「決定！」+ 拡大表示 |
| 触覚フィードバック | `navigator.vibrate`（対応端末のみ） |
| 入力アシスト | プレースホルダ、入力時の空白整形、30文字上限 |
| 自動更新（ポーリング） | 参加画面 3秒 / 管理画面 2秒 / 会場表示 2秒間隔で `GET` |
| 端末記憶 | 参加者名を `localStorage`、管理トークンを `sessionStorage` に保持 |
| トースト通知 | 保存・リセット成功時に表示 |
| 二段階確認モーダル | リセット時に確認語「RESET」のタイプ入力を要求 |
| QRコード | 会場表示で参加用URLを QR 表示（現在は外部 API `api.qrserver.com` を利用） |
| HTMLエスケープ | 表示名・チーム名はDOM経由でエスケープし XSS を防止 |

> 移植メモ: QRコードは外部APIに依存している。オフライン耐性・プライバシーを高めるならクライアント生成ライブラリへの差し替えを検討（DESIGNS.md 参照）。

---

## 7. 設定・環境依存（移植時の差し替え対象）

機能ロジックから切り離すべき、プラットフォーム固有の関心事。

| 関心事 | 現行（Cloudflare） | 移植時の検討（Vercel / Netlify 等） |
|--------|--------------------|--------------------------------------|
| 静的配信 | Workers Assets (`ASSETS` バインディング) | Vercel/Netlify の静的ホスティング + SPA リライト設定 |
| API 実行環境 | Workers `fetch` ハンドラ | Vercel Functions / Netlify Functions（または Edge Functions） |
| ルーティング | 手書きの `path.split` ルータ | フレームワークのファイルベースルーティングへ移植可 |
| DB | D1（SQLite） | Vercel Postgres / Neon / Turso / Supabase / PlanetScale 等 |
| ハッシュ | `crypto.subtle`（WebCrypto） | 各ランタイムの crypto（Node `crypto` / WebCrypto） |
| SPA フォールバック | 404 時に `index.html` 返却 | プラットフォームの rewrites/redirects 設定 |
| 管理トークン初期値 | seed SQL + ハッシュ生成スクリプト | 環境変数 + マイグレーション/シードへ移植 |

### 7.1 ブランチ運用方針（提案）

汎用性を持たせるため、プラットフォームごとにブランチを分けて運用する構想。

- `main`: プラットフォーム非依存のコア（SPA・業務ロジック・スキーマ・本ドキュメント群）を正とする。
- `deploy/cloudflare`: 現行の Workers + D1 構成（wrangler）。
- `deploy/vercel`: Vercel Functions + Postgres 系。
- `deploy/netlify`: Netlify Functions + 任意DB。

各デプロイブランチは「§4 API 仕様」「§3 データモデル」「§5 業務ルール」を満たすことを移植の合格条件とする。差分は §7 の関心事に限定する。

### 7.2 データベース候補と Free Tier（参考）

> **免責**: 以下の Free Tier（無料枠）の内容は **2026年6月21日時点** の調査に基づく参考情報であり、内容を **保証するものではない**。各サービスの料金・無料枠は予告なく変更される。**実際の採用・移行前には必ず各製品の公式ページで最新情報を確認すること。**

本アプリはリレーショナルDB（events / participants / assignments と UNIQUE 制約）を前提とするため、SQL 系サービスが対象。

| サービス | 種別 | Free Tier（2026-06-21 時点・無保証） | 自動課金リスク | 備考 |
|----------|------|--------------------------------------|----------------|------|
| Cloudflare D1 | SQLite | 5 GB・読み取り 2.5億行/日（無料プラン） | 低 | **現行構成**。Cloudflare に残す場合は移行コストゼロ |
| Turso | SQLite (libSQL) | 5 GB・読み取り 5億行/月 | 低 | SQLite 互換で **D1 からの移行が最も自然**。無料枠が大きい |
| Neon | Postgres | 0.5 GB/プロジェクト・100 CU-h/月・100プロジェクト | 低（Free Plan で停止） | ブランチ機能が強力。Vercel 統合が滑らか |
| Vercel Postgres | Postgres（Neon ベース） | Neon に準拠 | 低 | Vercel に寄せる場合の統合が容易 |
| Supabase | Postgres | 500 MB・2プロジェクト（Auth/ストレージ込み） | 低（プロジェクト制限型・非アクティブで一時停止） | BaaS 的に Auth まで一体運用可能 |
| TiDB Cloud Starter | MySQL 互換 | 行 5 GiB + カラム 5 GiB・5,000万 RU/月（インスタンス単位） | 低（超過時はスロットリング、自動課金なし） | RU 課金のため負荷の見積りがやや難しい |
| PlanetScale | MySQL / Postgres | **無料枠なし**（最安 約 $5/月） | — | 2024年に無料枠廃止、2026年も復活せず。候補外 |

補足:
- 「自動課金リスク低」とは、無料枠超過時に**勝手に課金されず停止/制限される**設計を指す（例: Neon は Free Plan で停止、TiDB Free Instance は throttle、課金には明示的アップグレードが必要）。ただしこれも各社の仕様変更で変わりうる。
- AWS RDS/Aurora 等の「12ヶ月無料」型は永続無料ではなく常時稼働前提のため、本アプリ（小規模・短期イベント）用途には過剰。Firebase/Firestore は NoSQL のため本データモデルには不向き。

### 7.3 推奨構成（デプロイ先 × DB の組み合わせ）

DB は単独で選ぶより **「どのデプロイ先に寄せるか」を起点に追従させる** と整理しやすい。本アプリ規模（小規模・低トラフィック・短期イベント）ではいずれも無料枠に収まる見込み。

| 優先したいこと | デプロイ先 | DB | 理由 |
|----------------|-----------|----|------|
| **移行コスト最小**（現状維持） | Cloudflare Workers | D1 (SQLite) | 現行スキーマ・コードそのまま。`deploy/cloudflare` ブランチ |
| **Vercel に寄せる** | Vercel Functions | Neon (Postgres) | Vercel 統合が最も滑らか。`deploy/vercel` ブランチ |
| **SQLite の書き味を維持しつつ移植性重視** | 任意（Vercel/Netlify 等） | Turso (libSQL) | libSQL が D1 に近く、プラットフォーム非依存。無料枠が大きい |
| **Auth 等を将来一体運用** | Vercel / Netlify | Supabase (Postgres) | DB + 認証 + ストレージを 1 サービスで拡張可能 |

> いずれの構成でも、合格条件は §7.1 のとおり「§3 データモデル / §4 API 仕様 / §5 業務ルールを満たすこと」。DB 差し替えで変わるのは SQL 方言（SQLite ↔ Postgres ↔ MySQL）と接続方法のみで、業務ロジックは不変とする。
>
> **繰り返しの注意**: 上記の無料枠・料金は 2026年6月21日時点の参考値であり無保証。採用前に各製品公式ページで最新情報を確認すること。

---

## 8. 受け入れ条件（機能の合格基準）

- [ ] 参加者が自分で名前入力 → くじ → チーム確定ができる
- [ ] 任意のチーム構成（例: 18名で `4,4,5,5` / `3,3,4,4,4`）が定員どおり埋まる
- [ ] 割り当てのみリセット / 完全リセットができる（管理者トークン必須・二段階確認）
- [ ] 同名・連打・二重送信・再訪で破綻しない（同名は409案内、draw は冪等）
- [ ] チーム一覧・残り枠・進捗が表示され、ポーリングで自動更新される
- [ ] 管理画面でイベント名・チーム構成・チーム名再生成ができ、§5.5 の整合性制約が効く
- [ ] 会場表示モードでQR・チーム一覧・自動更新が表示される
- [ ] 表示名・チーム名が XSS 安全に表示される

---

## 9. 既知の制約・改善余地

- `assignments.team_name` を名前文字列で持つため、割り当て後のチーム名変更が原則不可（ID参照化で緩和可能）。
- 抽選の乱数は `Math.random()`（暗号学的乱数ではない）。公平性には十分だが厳密な無作為性が要る用途は別途検討。
- QRコードが外部APIに依存（§6 メモ）。
- 管理者認証はイベント単位の共有トークンのみ（個別ユーザー認証なし）。
- レート制限・スパム対策は未実装。
