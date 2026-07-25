import { CognitoJwtVerifier } from "aws-jwt-verify";

const userPoolId = process.env.USER_POOL_ID;
const clientId = process.env.USER_POOL_CLIENT_ID;

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

if (userPoolId && clientId) {
  verifier = CognitoJwtVerifier.create({
    userPoolId,
    tokenUse: "id",
    clientId,
  });
}

export async function verifyAdminToken(tokenHeader: string | null): Promise<boolean> {
  if (!tokenHeader) return false;

  const token = tokenHeader.startsWith("Bearer ")
    ? tokenHeader.slice(7)
    : tokenHeader;

  // Local fallback if Cognito isn't set up yet
  if (!verifier) {
    return token.trim().length > 0;
  }

  try {
    const payload = await verifier.verify(token);
    return !!payload.sub;
  } catch (err) {
    console.error("Cognito JWT Verification Failed:", err);
    return false;
  }
}
