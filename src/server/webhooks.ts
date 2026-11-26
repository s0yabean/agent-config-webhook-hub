import { HttpError } from "./http";
import { readJson, writeJson, type BlobStore } from "./store";
import { normaliseParentId } from "./values";
import type { DeliveryLogEntry, IncomingWebhookLog, WebhookMapping } from "./types";

export const REGISTRY_KEY = "webhooks";
export const INCOMING_LOG_KEY = "incoming-webhook-logs";
export const LOG_LIMIT = 100;

/** WAHA chat IDs: "<digits>@c.us" for a person, "<digits>@g.us" for a group. */
const SENDER_ID_RE = /^\d{6,20}@(c|g)\.us$/;

export function deliveryLogKey(parentId: string): string {
  return `logs-${parentId}`;
}

/** What the API returns: the secret itself never leaves the server. */
export type PublicWebhook = Omit<WebhookMapping, "secret"> & { hasSecret: boolean };

export function toPublic(webhook: WebhookMapping): PublicWebhook {
  const { secret, ...rest } = webhook;
  return { ...rest, hasSecret: Boolean(secret) };
}

/**
 * Validate an admin's webhook payload. `existing` lets an update omit the
 * secret to keep the stored one; send `secret: ""` to clear it.
 */
export function validateWebhook(raw: unknown, existing?: WebhookMapping): WebhookMapping {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, "Webhook must be a JSON object");
  }
  const input = raw as Record<string, unknown>;

  if (!input.parentId) throw new HttpError(400, "parentId is required");
  const parentId = normaliseParentId(input.parentId);

  if (typeof input.webhookUrl !== "string" || !input.webhookUrl) {
    throw new HttpError(400, "webhookUrl is required");
  }
  let url: URL;
  try {
    url = new URL(input.webhookUrl);
  } catch {
    throw new HttpError(400, "Invalid webhook URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, "webhookUrl must be http or https");
  }

  if (typeof input.sender_id !== "string" || !input.sender_id) {
    throw new HttpError(400, "sender_id is required: only messages from this sender are forwarded");
  }
  if (!SENDER_ID_RE.test(input.sender_id)) {
    throw new HttpError(400, "sender_id must look like <digits>@c.us (or <digits>@g.us for a group)");
  }

  const headers: Record<string, string> = {};
  if (input.headers !== undefined) {
    if (typeof input.headers !== "object" || input.headers === null || Array.isArray(input.headers)) {
      throw new HttpError(400, "headers must be an object of strings");
    }
    for (const [k, v] of Object.entries(input.headers)) {
      if (typeof v !== "string") throw new HttpError(400, `Header "${k}" must be a string`);
      if (k.trim()) headers[k.trim()] = v;
    }
  }

  let secret: string | undefined;
  if (input.secret === undefined) secret = existing?.secret;
  else if (typeof input.secret === "string") secret = input.secret || undefined;
  else throw new HttpError(400, "secret must be a string");

  const description = typeof input.description === "string" ? input.description.slice(0, 500) : undefined;

  return {
    parentId,
    webhookUrl: url.toString(),
    sender_id: input.sender_id,
    description: description || undefined,
    isActive: input.isActive === undefined ? true : Boolean(input.isActive),
    headers: Object.keys(headers).length ? headers : undefined,
    secret,
    lastUsed: existing?.lastUsed
  };
}

export async function listWebhooks(store: BlobStore): Promise<WebhookMapping[]> {
  const list = await readJson<WebhookMapping[]>(store, REGISTRY_KEY, []);
  return Array.isArray(list) ? list : [];
}

export async function findWebhook(store: BlobStore, parentId: string): Promise<WebhookMapping> {
  const webhook = (await listWebhooks(store)).find((w) => w.parentId === parentId);
  if (!webhook) throw new HttpError(404, `No webhook found for parentId: ${parentId}`);
  return webhook;
}

export async function saveWebhook(store: BlobStore, raw: unknown): Promise<{ created: boolean; webhook: WebhookMapping }> {
  const list = await listWebhooks(store);
  const parentId = typeof raw === "object" && raw ? (raw as { parentId?: unknown }).parentId : undefined;
  const index = list.findIndex((w) => w.parentId === parentId);
  const webhook = validateWebhook(raw, index >= 0 ? list[index] : undefined);

  const clash = list.find((w) => w.isActive && webhook.isActive && w.sender_id === webhook.sender_id && w.parentId !== webhook.parentId);
  if (clash) {
    throw new HttpError(409, `Sender ${webhook.sender_id} is already routed to parentId: ${clash.parentId}`);
  }

  if (index >= 0) list[index] = webhook;
  else list.push(webhook);
  await writeJson(store, REGISTRY_KEY, list);
  return { created: index < 0, webhook };
}

export async function deleteWebhook(store: BlobStore, parentId: string): Promise<void> {
  const list = await listWebhooks(store);
  const next = list.filter((w) => w.parentId !== parentId);
  if (next.length === list.length) throw new HttpError(404, `No webhook found for parentId: ${parentId}`);
  await writeJson(store, REGISTRY_KEY, next);
}

export async function touchWebhook(store: BlobStore, parentId: string, at: Date): Promise<void> {
  const list = await listWebhooks(store);
  const hit = list.find((w) => w.parentId === parentId);
  if (!hit) return;
  hit.lastUsed = at.toISOString();
  await writeJson(store, REGISTRY_KEY, list);
}

/** Newest first, capped at LOG_LIMIT. */
async function prependCapped<T>(store: BlobStore, key: string, entry: T): Promise<void> {
  const existing = await readJson<T[]>(store, key, []);
  const list = Array.isArray(existing) ? existing : [];
  await writeJson(store, key, [entry, ...list].slice(0, LOG_LIMIT));
}

export async function appendDeliveryLog(store: BlobStore, entry: DeliveryLogEntry): Promise<void> {
  await prependCapped(store, deliveryLogKey(entry.parentId), entry);
}

export async function appendIncomingLog(store: BlobStore, entry: IncomingWebhookLog): Promise<void> {
  await prependCapped(store, INCOMING_LOG_KEY, entry);
}

function newestFirst<T extends { timestamp: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

export async function readDeliveryLogs(store: BlobStore, parentId: string): Promise<DeliveryLogEntry[]> {
  const list = await readJson<DeliveryLogEntry[]>(store, deliveryLogKey(parentId), []);
  return Array.isArray(list) ? newestFirst(list) : [];
}

export async function readIncomingLogs(store: BlobStore): Promise<IncomingWebhookLog[]> {
  const list = await readJson<IncomingWebhookLog[]>(store, INCOMING_LOG_KEY, []);
  return Array.isArray(list) ? newestFirst(list) : [];
}
