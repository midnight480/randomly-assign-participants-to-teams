import type { EventPattern } from "./types";

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function parsePattern(patternJson: string): EventPattern | null {
  try {
    const p = JSON.parse(patternJson) as EventPattern;
    if (!p.teams || !Array.isArray(p.teams)) return null;
    return p;
  } catch {
    return null;
  }
}

export function normalizeDisplayName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 30);
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
