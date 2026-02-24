#!/usr/bin/env node
// 管理者トークンの SHA-256 ハッシュを生成します。
// 使用例: node scripts/gen-seed-hash.js
//        ADMIN_TOKEN=sagachoiraku node scripts/gen-seed-hash.js
const token = process.env.ADMIN_TOKEN || "sagachoiraku";
const crypto = require("crypto");
const hash = crypto.createHash("sha256").update(token).digest("hex");
console.log("Token:", token);
console.log("SHA-256:", hash);
console.log("\nseed.sql の admin_token_hash を上記の値に置き換えてください。");
