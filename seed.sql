-- サンプルイベント作成（管理者トークン: sagachoiraku）
-- ハッシュ生成: node scripts/gen-seed-hash.js で admin_token_hash を取得し、下記を置換

-- 4チーム 4,4,5,5 のイベント SA2026（佐賀弁チーム名）
INSERT OR IGNORE INTO events (event_code, title, pattern_json, admin_token_hash) VALUES (
  'SA2026',
  'ちょいラク未来デザイン アイディアソン',
  '{"teams":[{"name":"がばい","size":4},{"name":"ぼちぼち","size":4},{"name":"やーらしか","size":5},{"name":"よかろうもん","size":5}]}',
  '9d8c0b0ad040b71d3c8e7795eb2c2250c1c7fe9f49a2ee575b0d1b9d745d7356'
);

-- 5チーム 3,3,4,4,4 の例（佐賀弁チーム名）
INSERT OR IGNORE INTO events (event_code, title, pattern_json, admin_token_hash) VALUES (
  'DEMO',
  'デモイベント（5チーム）',
  '{"teams":[{"name":"よか","size":3},{"name":"うまか","size":3},{"name":"あったか","size":4},{"name":"のんびり","size":4},{"name":"ほっこり","size":4}]}',
  '9d8c0b0ad040b71d3c8e7795eb2c2250c1c7fe9f49a2ee575b0d1b9d745d7356'
);
