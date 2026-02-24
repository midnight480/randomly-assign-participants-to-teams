import type { Env } from "./env";
import {
  handleGetEvent,
  handlePostParticipants,
  handlePostDraw,
  handleResetAssignments,
  handleResetAll,
  handlePatchEvent,
  handleRegenerateTeamNames,
} from "./api";
import { errorResponse } from "./util";

function getAdminToken(request: Request): string | null {
  const encoded = request.headers.get("X-Admin-Token");
  if (!encoded) return null;
  try {
    return decodeURIComponent(escape(atob(encoded)));
  } catch {
    return encoded; // Fallback for non-base64 tokens
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path.startsWith("/api/")) {
      const db = env.DB;
      if (!db) {
        return errorResponse("Database not configured", 500);
      }

      const apiPath = path.slice(4);
      const segments = apiPath.split("/").filter(Boolean);

      if (segments[0] === "events" && segments.length >= 2) {
        const eventCode = decodeURIComponent(segments[1]);

        if (segments.length === 2) {
          if (method === "GET") {
            return handleGetEvent(db, eventCode);
          }
          if (method === "PATCH") {
            const body = await request.json().catch(() => ({}));
            return handlePatchEvent(db, eventCode, getAdminToken(request), body as { title?: string; pattern?: { teams: { name: string; size: number }[] } });
          }
        }

        if (segments.length === 3 && segments[2] === "participants") {
          if (method === "POST") {
            const body = await request.json().catch(() => ({}));
            return handlePostParticipants(db, eventCode, body as { display_name?: string });
          }
        }

        if (segments.length === 3 && segments[2] === "draw") {
          if (method === "POST") {
            const body = await request.json().catch(() => ({}));
            return handlePostDraw(db, eventCode, body as { display_name?: string });
          }
        }

        if (
          segments.length === 4 &&
          segments[2] === "admin" &&
          segments[3] === "reset-assignments"
        ) {
          if (method === "POST") {
            return handleResetAssignments(db, eventCode, getAdminToken(request));
          }
        }

        if (
          segments.length === 4 &&
          segments[2] === "admin" &&
          segments[3] === "reset-all"
        ) {
          if (method === "POST") {
            return handleResetAll(db, eventCode, getAdminToken(request));
          }
        }

        if (
          segments.length === 4 &&
          segments[2] === "admin" &&
          segments[3] === "regenerate-team-names"
        ) {
          if (method === "POST") {
            return handleRegenerateTeamNames(db, eventCode, getAdminToken(request));
          }
        }
      }

      return errorResponse("Not Found", 404);
    }

    if (env.ASSETS) {
      let assetPath = path === "/" ? "/index.html" : path;
      const assetRequest = new Request(new URL(assetPath, request.url), {
        method: request.method,
        headers: request.headers,
      });
      const response = await env.ASSETS.fetch(assetRequest);
      if (response.status === 404 && !assetPath.includes(".")) {
        const indexRequest = new Request(new URL("/index.html", request.url), {
          method: request.method,
          headers: request.headers,
        });
        return env.ASSETS.fetch(indexRequest);
      }
      return response;
    }

    return errorResponse("Not Found", 404);
  },
};
