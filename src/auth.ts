import { CognitoJwtVerifier } from "aws-jwt-verify";

const userPoolId = process.env.USER_POOL_ID;
const clientId = process.env.USER_POOL_CLIENT_ID;

const verifier =
  userPoolId && clientId
    ? CognitoJwtVerifier.create({ userPoolId, tokenUse: "id", clientId })
    : null;

/**
 * 管理者操作用の Cognito ID トークン検証。
 * Cognito が未設定の場合は「誰でも通る」のではなく必ず拒否する（fail closed）。
 */
export async function verifyAdminToken(tokenHeader: string | null): Promise<boolean> {
  if (!tokenHeader) return false;

  if (!verifier) {
    console.error("USER_POOL_ID / USER_POOL_CLIENT_ID が未設定のため認証を拒否しました");
    return false;
  }

  const token = tokenHeader.startsWith("Bearer ") ? tokenHeader.slice(7) : tokenHeader;

  try {
    const payload = await verifier.verify(token);
    return !!payload.sub;
  } catch (err) {
    console.error("Cognito JWT Verification Failed:", err);
    return false;
  }
}
