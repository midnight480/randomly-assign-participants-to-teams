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

---

# 実装ログ

作業者: Claude Code / 期間: 2026-07-26

## 前提となった状況

AntigravityIDE が `868fdfb` で一通り実装し、us-east-1 にデプロイ済みだった。
ただし検証が curl による API 直叩きのみで、ブラウザからの動作確認がされておらず、
実際には本番で破綻する不具合が複数残っていた。

## フェーズ1: 致命的不具合の修正（commit `a4845fb`）

| # | 症状 | 原因 | 対応 |
|---|---|---|---|
| 1 | 参加者に結果が見えない／リロードで消える | SQLite を Lambda `/tmp` に配置。`/tmp` は実行環境ごとに独立で共有されない | DynamoDB へ移行（`src/db.ts`） |
| 2 | ブラウザで画面が全く出ない | REST API の URL が `/prod/...`。フロントは `/api/config`・`/styles.css` と絶対パス参照でステージ名が抜ける | HTTP API の `$default` ステージへ |
| 3 | 静的ファイルが 404 | `STATIC_DIR` が `__dirname/../public` を指し Lambda 上で `/public` になっていた | `__dirname/public` に修正＋パストラバーサル対策＋バイナリ配信対応 |
| 4 | リアルタイム更新が動かない | AppSync Events の ChannelNamespace 未作成。フロントの WebSocket も GraphQL 用手順 | ネームスペース追加＋Events 用プロトコルに書き直し |
| 5 | 管理者がログインできない | `CfnUserPoolUser` のみだと `FORCE_CHANGE_PASSWORD` のまま | `AwsCustomResource` で恒久パスワード設定 |
| 6 | 誰でも管理者操作できる | Cognito 未設定時に任意トークンを通すフォールバック＋self sign-up 有効 | fail closed 化＋self sign-up 無効化 |
| 7 | Bedrock コメントが定型文 | 呼び出しが失敗しフォールバック文言が出ていた（報告では成功扱い） | ユーザー判断により Bedrock 削除、佐賀弁定型コメントへ |
| 8 | `cdk deploy` が不安定 | `ts-node` 未インストール | devDependencies に追加 |

チーム分けアルゴリズムと佐賀弁チーム名（`SAGA_WORDS` / `pickRandomSagaNames` / 枠数計算）は変更していない。

## フェーズ2: テスト整備と検証

AWS 認証情報を使わずに検証できる範囲を最大化するため、テストを整備した。

### テスト可能にするための小規模リファクタ（挙動は不変）

- `src/api.ts`: 振り分けロジックを純粋関数 `buildTeams()` として抽出。
  認証・永続化・通知から切り離した。
- `src/db.ts`: `DYNAMODB_ENDPOINT` 環境変数に対応（DynamoDB Local 用。Lambda 上では未設定）。
- `src/handler.ts`: `STATIC_DIR` 環境変数で静的ファイルの場所を上書き可能にした。
- `import type { Team }` へ修正（型を値としてインポートしていた）。

### テスト構成

`npm test` で以下を実行（`scripts/run-tests.sh` が Docker のライフサイクルまで面倒を見る）。
Docker が無い環境では単体テストのみにフォールバックする。

| ファイル | 内容 | 件数 |
|---|---|---|
| `test/build-teams.test.ts` | 振り分けロジックの単体テスト | 10 |
| `test/db.test.ts` | DynamoDB Local を使った永続化の統合テスト | 7 |
| `test/handler.test.ts` | ルーティング・静的配信・認証ゲートの統合テスト | 16 |

**結果: 33件すべてパス。**

主に次の観点を押さえている。

- 全参加者がちょうど1回だけ割り当てられる（欠落・重複なし）— 参加者1〜40名 × 1〜5チームの組み合わせで検証
- チーム人数の差が最大1名に収まる／`size` が実メンバー数と一致する
- 参加者数 < チーム数、チーム数 0 以下などの端に落ちない
- 佐賀弁チーム名が重複しない／語彙数を超えたら連番で埋める
- 保存した状態が別呼び出しから読める（Lambda コンテナ跨ぎの再現）
- 部分更新で他フィールドが消えない
- 日本語・記号・絵文字を含む名前が壊れずに往復する
- `/e/*` が SPA ルーティングとして index.html を返す
- **パストラバーサル**（`/../package.json`、`/%2e%2e/`、`/....//` など）で public 外を読めない
- **認証が fail closed**（トークン無し・でたらめなトークンで 401、状態も壊れない）
- 壊れた JSON ボディ・base64 ボディで落ちない

### テスト整備中に見つかった不具合

- テストファイル間で DynamoDB Local の同一テーブルを共有しており、並列実行だと
  `beforeEach` のテーブル作り直しが他ファイルの実行中に走って失敗していた。
  `--test-concurrency=1` で直列実行に固定した（全体1秒未満なので実害なし）。

## フェーズ3: セキュリティ自己レビューで見つけた点

引き渡し前に差分を見直して、当日の運用リスクを2つ潰した。

### 1. AppSync の API キーは公開情報である

参加者画面が購読するために `/api/config` で API キーを返しており、第三者も
同じチャンネルに publish できる。ただし**偽データが表示されることはない**:
参加者画面は通知をトリガーにするだけで、中身は必ず `/api/events/{code}` から
取り直しているため。

残る影響は「通知を連打してバックエンドを叩かせる」こと。フロント側で
**再取得を1秒に1回までスロットル**して緩和した（末尾の通知は取りこぼさない）。

publish を IAM 認証に限定すれば根本的に塞げるが、Lambda 側で SigV4 署名が必要になる。
影響が「再取得の誘発」に留まることと、単発イベントであることを踏まえて採用しなかった。

### 2. 参加者登録 API が無認証

元の仕様どおり参加者の自己登録を許しているが、無制限だと DynamoDB の
アイテムサイズ上限(400KB)に達してイベントの状態そのものが壊れうる。

**参加者数の上限を500名**とし、超える場合は全件拒否するようにした
（中途半端に保存されると状況が分かりにくいため all-or-nothing）。
管理者のシャッフル実行時も同じ上限で検証する。

## フェーズ4: 整理

- Cloudflare 時代の残骸を削除: `wrangler.toml` / `migrations/` / `seed.sql` /
  `.dev.vars.example` / `scripts/gen-seed-hash.js` / `.wrangler/`。
  いずれもコードからの参照は無く、レビュー時のノイズになるため。
  （Cloudflare 版は `main` ブランチに残っている）
- `src/env.ts` / `src/index.ts` / `src/types.ts` を削除（Workers 前提の死んだコード）。
- `src/util.ts` から未使用の `sha256Hex` / `parsePattern` を削除。
- `README.md` を AWS 版の内容に全面改稿。
- Lambda ランタイムを Node.js 20（非推奨）から 22 へ更新。

## 検証状況

| 項目 | 状態 |
|---|---|
| `npm run typecheck` | ✅ エラーなし |
| `npm test`（35件） | ✅ 全パス |
| `cdk synth` | ✅ 成功。DynamoDB / ChannelNamespace / `$default` ステージ / Lambda アセットへの `public/` 同梱をテンプレート上で確認 |
| `public/app.js` 構文 | ✅ パース可能 |
| **実 AWS へのデプロイ** | ❌ 未実施（認証情報を使わない方針のため） |
| **ブラウザでの動作確認** | ❌ 未実施 |
| **AppSync Events のリアルタイム更新** | ❌ 実機確認が必要 |

## デプロイ時に注意が必要な残リスク

1. **AppSync Events の Osaka 提供状況** — 未確認。`cdk deploy` で失敗したら
   `APP_REGION=ap-northeast-1` で東京へ。
2. **AppSync Events の WebSocket** — プロトコルはドキュメント準拠で実装したが実機未検証。
   仮に接続できなくても参加者画面は3秒ポーリングで結果を表示できる。
   ブラウザのコンソールに `AppSync Events 購読開始:` が出れば成功。
3. **旧 us-east-1 スタックの撤収** — 別途 `APP_REGION=us-east-1 npx cdk destroy` が必要。
4. **AWS アクセスキーのローテーション** — チャットに平文で共有されたキーは無効化すること。

---

## 設計メモ

- **DynamoDB を使う理由**: Lambda の `/tmp` は実行環境ごとに独立しており、複数コンテナに分散すると管理者が書いた結果を参加者が読めない。当日は参加者が一斉アクセスするため確実に分散する。
- **HTTP API を使う理由**: REST API は URL が `/prod/...` になり、フロントの絶対パス（`/api/...`, `/styles.css`）が届かなくなる。`$default` ステージならパスにステージ名が入らない。
- **Cognito の恒久パスワード**: `CfnUserPoolUser` だけでは `FORCE_CHANGE_PASSWORD` のままログインできないため、`AwsCustomResource` で `AdminSetUserPassword` を実行している。
- **AppSync Events のフォールバック**: 参加者画面は WebSocket 購読に加えて 3 秒ポーリングも併用しているため、リアルタイム通知が落ちても結果は反映される。
