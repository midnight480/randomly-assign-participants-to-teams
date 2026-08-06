export function normalizeDisplayName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 30);
}

/**
 * チーム名を整える。表示名と違い、URL やコメントのキーになるわけではないが、
 * 前後の空白や全角スペースだけの名前が混ざると会場表示が崩れるので揃えておく。
 */
export function normalizeTeamName(name: string, maxLength = 20): string {
  return String(name ?? "")
    .replace(/[　\s]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}
