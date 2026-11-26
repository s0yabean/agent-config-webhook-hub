import { createHmac } from "node:crypto";
import { safeEqual } from "./auth";
import { header, rawBody } from "./http";
import {
  appendDeliveryLog,
  appendIncomingLog,
  listWebhooks,
  touchWebhook
} from "./webhooks";
import type { Deps, FnEvent, IncomingStatus, WebhookMapping } from "./types";

const USER_AGENT = "agent-config-webhook-hub/0.1";
const MAX_LOGGED_PAYLOAD_CHARS = 10_000;

/** Netlify's synchronous functions stop at 10 s by default, so keep the worst case under that. */
export const FORWARD_POLICY = {
  maxAttempts: 3,
  timeoutMs: 2500,
  retryDelaysMs: [250, 1000]
};

/**
 * The sender of an incoming event. WAHA "message" events carry it in
 * payload.from ("<digits>@c.us"); the other shape seen in the original
 * traffic put it in sender.attendee_provider_id.
 */
export function extractSenderId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { event?: unknown; payload?: { from?: unknown }; sender?: { attendee_provider_id?: unknown } };
  if (p.event === "message" && typeof p.payload?.from === "string" && p.payload.from) return p.payload.from;
  if (typeof p.sender?.attendee_provider_id === "string" && p.sender.attendee_provider_id) {
    return p.sender.attendee_provider_id;
  }
  return null;
}

export function eventType(payload: unknown): string {
  const e = (payload as { event?: unknown } | null)?.event;
  return typeof e === "string" && e ? e : "unknown";
}

/** HMAC-SHA512 of the raw body, hex, as sent in X-Webhook-Hmac. */
export function inboundHmac(body: string, secret: string): string {
  return createHmac("sha512", secret).update(body).digest("hex");
}

export function verifyInboundHmac(body: string, sent: string | undefined, secret: string): boolean {
  if (!sent) return false;
  return safeEqual(sent.trim().toLowerCase(), inboundHmac(body, secret));
}

/** HMAC-SHA256 of the forwarded body, hex, sent to the agent as X-Webhook-Signature. */
export function outboundSignature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function routeSender(webhooks: WebhookMapping[], senderId: string): WebhookMapping | undefined {
  return webhooks.find((w) => w.isActive && w.sender_id === senderId);
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface ForwardResult {
  success: boolean;
  statusCode?: number;
  error?: string;
  attempts: number;
  responseTime: number;
}

/**
 * POST the payload to the agent workflow. Retries network errors, 429 and 5xx;
 * a 4xx is the target saying no, so it is not retried.
 */
export async function forward(
  deps: Pick<Deps, "fetch" | "sleep">,
  webhook: WebhookMapping,
  body: string,
  extraHeaders: Record<string, string> = {},
  policy = FORWARD_POLICY
): Promise<ForwardResult> {
  const started = Date.now();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "X-Forwarded-By": "agent-config-webhook-hub",
    ...(webhook.headers || {}),
    ...extraHeaders
  };
  if (webhook.secret) headers["X-Webhook-Signature"] = outboundSignature(body, webhook.secret);

  let lastError = "";
  let statusCode: number | undefined;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      const res = await deps.fetch(webhook.webhookUrl, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(policy.timeoutMs)
      });
      statusCode = res.status;
      if (res.ok) {
        return { success: true, statusCode, attempts: attempt, responseTime: Date.now() - started };
      }
      const text = (await res.text().catch(() => "")).slice(0, 300);
      lastError = `Target returned ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`;
      if (!retryable(res.status)) {
        return { success: false, statusCode, error: lastError, attempts: attempt, responseTime: Date.now() - started };
      }
    } catch (error) {
      lastError = `Could not reach target: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (attempt < policy.maxAttempts) await deps.sleep(policy.retryDelaysMs[attempt - 1] ?? 1000);
  }
  return {
    success: false,
    statusCode,
    error: `All ${policy.maxAttempts} attempts failed. Last error: ${lastError}`,
    attempts: policy.maxAttempts,
    responseTime: Date.now() - started
  };
}

function loggablePayload(env: NodeJS.ProcessEnv, payload: unknown): unknown {
  if (env.LOG_RAW_PAYLOADS === "false") return "[not logged: LOG_RAW_PAYLOADS=false]";
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (text && text.length > MAX_LOGGED_PAYLOAD_CHARS) {
    return `${text.slice(0, MAX_LOGGED_PAYLOAD_CHARS)}... [truncated]`;
  }
  return payload;
}

export interface ReceiveOutcome {
  statusCode: number;
  body: Record<string, unknown>;
}

/**
 * Handle one incoming WAHA webhook: verify, find the route for its sender,
 * forward it, and write exactly one incoming-log entry saying what happened.
 */
export async function receiveWebhook(deps: Deps, event: FnEvent): Promise<ReceiveOutcome> {
  const store = deps.stores.webhooks;
  const body = rawBody(event);

  const log = async (
    status: IncomingStatus,
    payload: unknown,
    senderId: string | null,
    parentId: string | null,
    reason?: string
  ) => {
    await appendIncomingLog(store, {
      timestamp: deps.now().toISOString(),
      sender_id: senderId || "unknown",
      event_type: eventType(payload),
      raw_payload: loggablePayload(deps.env, payload),
      determined_parent_id: parentId,
      status,
      reason
    });
  };

  const reject = async (statusCode: number, reason: string, payload: unknown, senderId: string | null = null) => {
    await log("rejected", payload, senderId, null, reason);
    return { statusCode, body: { success: false, error: reason, ...(senderId ? { sender: senderId } : {}) } };
  };

  if (!body) return reject(400, "Request body is required", null);

  const inboundSecret = deps.env.INBOUND_HMAC_SECRET;
  if (inboundSecret && !verifyInboundHmac(body, header(event, "x-webhook-hmac"), inboundSecret)) {
    return reject(401, "Missing or invalid X-Webhook-Hmac", "[body not logged: failed HMAC check]");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return reject(400, "Invalid JSON in request body", body);
  }

  const senderId = extractSenderId(payload);
  if (!senderId) return reject(403, "No sender ID in payload", payload);

  const webhook = routeSender(await listWebhooks(store), senderId);
  if (!webhook) return reject(403, "No matching webhook configuration for this sender", payload, senderId);

  const result = await forward(deps, webhook, body);
  const now = deps.now();
  await appendDeliveryLog(store, {
    timestamp: now.toISOString(),
    parentId: webhook.parentId,
    success: result.success,
    statusCode: result.statusCode,
    error: result.error,
    payloadSize: Buffer.byteLength(body),
    responseTime: result.responseTime,
    attempts: result.attempts
  });
  await touchWebhook(store, webhook.parentId, now);
  await log(result.success ? "forwarded" : "failed", payload, senderId, webhook.parentId, result.error);

  return result.success
    ? { statusCode: 200, body: { success: true, parentId: webhook.parentId, attempts: result.attempts } }
    : { statusCode: 502, body: { success: false, parentId: webhook.parentId, error: result.error } };
}
