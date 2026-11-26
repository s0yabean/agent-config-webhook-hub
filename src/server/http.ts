import type { FnEvent, FnResult } from "./types";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, X-Webhook-Hmac",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS"
};

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export function json(statusCode: number, body: unknown): FnResult {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

export function preflight(): FnResult {
  return { statusCode: 204, headers: { ...CORS_HEADERS }, body: "" };
}

export function header(event: FnEvent, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(event.headers || {})) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export function query(event: FnEvent, name: string): string | undefined {
  const value = event.queryStringParameters?.[name];
  return value === undefined || value === "" ? undefined : value;
}

/** Raw body as a string (Netlify may base64-encode it). */
export function rawBody(event: FnEvent): string {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

export function parseJsonBody<T = unknown>(event: FnEvent): T {
  const body = rawBody(event);
  if (!body) throw new HttpError(400, "Request body is required");
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON in request body");
  }
}

/**
 * The path segment after the function name, e.g. "support-bot" in
 * /.netlify/functions/getWebhook/support-bot or /api/getWebhook/support-bot.
 */
export function pathParam(event: FnEvent, fnName: string): string | undefined {
  const parts = (event.path || "").split("/").filter(Boolean);
  const i = parts.lastIndexOf(fnName);
  if (i === -1 || i === parts.length - 1) return undefined;
  return decodeURIComponent(parts[i + 1]);
}
