import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  handleGetEvent,
  handlePostParticipants,
  handleExecuteShuffle,
  handleResetAssignments,
} from "./api";
import { jsonResponse, errorResponse } from "./util";
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import * as fs from "fs";
import * as path from "path";

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION || "us-east-1",
});

const STATIC_DIR = path.join(__dirname, "../public");

function getMimeType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "text/plain; charset=utf-8";
}

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const httpMethod = event.httpMethod || "GET";
  const requestPath = event.path || "/";

  // Handle API Endpoints
  if (requestPath.startsWith("/api/")) {
    try {
      const authHeader =
        event.headers?.Authorization ||
        event.headers?.authorization ||
        event.headers?.["X-Admin-Token"] ||
        event.headers?.["x-admin-token"] ||
        null;

      // Auth endpoint for Admin Login with Cognito
      if (requestPath === "/api/auth/login" && httpMethod === "POST") {
        const body = JSON.parse(event.body || "{}");
        const { email, password } = body;

        const clientId = process.env.USER_POOL_CLIENT_ID;
        if (!clientId) {
          return {
            statusCode: 500,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Cognito User Pool Client not configured" }),
          };
        }

        const command = new InitiateAuthCommand({
          AuthFlow: "USER_PASSWORD_AUTH",
          ClientId: clientId,
          AuthParameters: {
            USERNAME: email,
            PASSWORD: password,
          },
        });

        const authResult = await cognitoClient.send(command);
        const idToken = authResult.AuthenticationResult?.IdToken;
        const accessToken = authResult.AuthenticationResult?.AccessToken;

        if (!idToken) {
          return {
            statusCode: 401,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Cognito login failed" }),
          };
        }

        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: idToken,
            accessToken,
            user: { email },
          }),
        };
      }

      // Config endpoint for frontend (Cognito & AppSync settings)
      if (requestPath === "/api/config" && httpMethod === "GET") {
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userPoolId: process.env.USER_POOL_ID || "",
            userPoolClientId: process.env.USER_POOL_CLIENT_ID || "",
            appsyncEndpoint: process.env.APPSYNC_HTTP_ENDPOINT || "",
            appsyncApiKey: process.env.APPSYNC_API_KEY || "",
          }),
        };
      }

      const segments = requestPath.slice(4).split("/").filter(Boolean);
      const eventCode = segments[1] ? decodeURIComponent(segments[1]) : "JAWS-SAGA";

      if (segments[0] === "events") {
        if (segments.length <= 2 && httpMethod === "GET") {
          const res = await handleGetEvent(eventCode);
          return await formatResponse(res);
        }

        if (segments.length === 3 && segments[2] === "participants" && httpMethod === "POST") {
          const body = JSON.parse(event.body || "{}");
          const res = await handlePostParticipants(eventCode, body);
          return await formatResponse(res);
        }

        if (segments.length >= 3 && segments[2] === "admin") {
          const action = segments[3];
          const body = JSON.parse(event.body || "{}");

          if (action === "shuffle" && httpMethod === "POST") {
            const res = await handleExecuteShuffle(eventCode, authHeader, body);
            return await formatResponse(res);
          }

          if (action === "reset" && httpMethod === "POST") {
            const res = await handleResetAssignments(eventCode, authHeader);
            return await formatResponse(res);
          }
        }
      }

      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "API Endpoint Not Found" }),
      };
    } catch (err: any) {
      console.error("API Error:", err);
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: err.message || "Internal Server Error" }),
      };
    }
  }

  // Serve Static Frontend Assets
  let relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\//, "");
  if (relativePath.startsWith("e/")) {
    relativePath = "index.html"; // Single-page app routing for /e/*
  }

  let filePath = path.join(STATIC_DIR, relativePath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(STATIC_DIR, "index.html");
  }

  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    return {
      statusCode: 200,
      headers: {
        "Content-Type": getMimeType(filePath),
        "Cache-Control": "public, max-age=300",
      },
      body: content,
    };
  }

  return {
    statusCode: 404,
    headers: { "Content-Type": "text/plain" },
    body: "Not Found",
  };
}

async function formatResponse(res: Response): Promise<APIGatewayProxyResult> {
  const bodyText = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return {
    statusCode: res.status,
    headers,
    body: bodyText,
  };
}
