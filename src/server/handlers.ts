import { authRequired, checkPassword, issueToken, requireAdmin, requireReader } from "./auth";
import { HttpError, json, parseJsonBody, pathParam, preflight, query } from "./http";
import { forward, receiveWebhook } from "./receiver";
import type { Deps, FnEvent, FnResult } from "./types";
import {
  deleteKeys,
  deleteNamespace,
  getValue,
  listParentIds,
  normaliseParentId,
  parseSearchTerms,
  readPairs,
  saveValues,
  validatePairs,
  filterPairs
} from "./values";
import {
  appendDeliveryLog,
  deleteWebhook,
  findWebhook,
  listWebhooks,
  readDeliveryLogs,
  readIncomingLogs,
  saveWebhook,
  toPublic,
  touchWebhook
} from "./webhooks";

export type Handler = (event: FnEvent, deps: Deps) => Promise<FnResult>;

function route(methods: string[], fn: Handler): Handler {
  return async (event, deps) => {
    if (event.httpMethod === "OPTIONS") return preflight();
    if (!methods.includes(event.httpMethod)) {
      return json(405, { success: false, error: `Method not allowed. Use ${methods.join(" or ")}.` });
    }
    try {
      return await fn(event, deps);
    } catch (error) {
      if (error instanceof HttpError) {
        return json(error.statusCode, { success: false, error: error.message, ...error.extra });
      }
      console.error("Unhandled error", error);
      return json(500, { success: false, error: "Internal server error" });
    }
  };
}

function requiredParentId(event: FnEvent, fnName: string): string {
  const raw = pathParam(event, fnName) ?? query(event, "parentId");
  if (!raw) throw new HttpError(400, "parentId is required");
  return normaliseParentId(raw);
}

// ---------- auth ----------

/** GET: does the panel need a password? POST {password}: exchange it for a session token. */
export const login = route(["GET", "POST"], async (event, deps) => {
  if (event.httpMethod === "GET") {
    return json(200, { success: true, authRequired: authRequired(deps.env) });
  }
  const { password } = parseJsonBody<{ password?: unknown }>(event);
  if (!deps.env.ADMIN_PASSWORD) {
    throw new HttpError(authRequired(deps.env) ? 503 : 400, "ADMIN_PASSWORD is not set");
  }
  if (!checkPassword(deps.env, password)) throw new HttpError(401, "Invalid password");
  return json(200, { success: true, ...issueToken(deps.env, deps.now()) });
});

// ---------- config values (agents read, admins write) ----------

export const getValueHandler = route(["GET"], async (event, deps) => {
  requireReader(event, deps.env, deps.now());
  const key = query(event, "key") ?? pathParam(event, "getValue");
  if (!key) throw new HttpError(400, "Key not provided");
  const parentId = normaliseParentId(query(event, "parentId"));
  const value = await getValue(deps.stores.values, parentId, key);
  return json(200, { success: true, value });
});

export const getAllValues = route(["GET"], async (event, deps) => {
  requireReader(event, deps.env, deps.now());
  const parentId = normaliseParentId(query(event, "parentId"));
  const pairs = (await readPairs(deps.stores.values, parentId)) ?? {};
  return json(200, { success: true, pairs });
});

export const getFilteredValues = route(["GET"], async (event, deps) => {
  requireReader(event, deps.env, deps.now());
  const parentId = normaliseParentId(query(event, "parentId"));
  const pairs = (await readPairs(deps.stores.values, parentId)) ?? {};
  const terms = parseSearchTerms(query(event, "searchTerms"));
  return json(200, { success: true, pairs: filterPairs(pairs, terms) });
});

export const getAllParentIds = route(["GET"], async (event, deps) => {
  requireReader(event, deps.env, deps.now());
  return json(200, { success: true, parentIds: await listParentIds(deps.stores.values) });
});

export const saveValuesHandler = route(["POST"], async (event, deps) => {
  requireAdmin(event, deps.env, deps.now());
  const body = parseJsonBody<{ pairs?: unknown; parentId?: unknown; mode?: unknown }>(event);
  const parentId = normaliseParentId(body.parentId);
  const pairs = validatePairs(body.pairs);
  if (body.mode !== undefined && body.mode !== "merge" && body.mode !== "replace") {
    throw new HttpError(400, 'mode must be "merge" or "replace"');
  }
  const counts = await saveValues(deps.stores.values, parentId, pairs, (body.mode as "merge" | "replace") || "merge");
  return json(200, {
    success: true,
    parentId,
    ...counts,
    message: `Saved for parentId: ${parentId} (${counts.added} new, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.removed} removed)`
  });
});

export const deleteValue = route(["DELETE"], async (event, deps) => {
  requireAdmin(event, deps.env, deps.now());
  const key = query(event, "key") ?? pathParam(event, "deleteValue");
  if (!key) throw new HttpError(400, "Key not provided");
  const parentId = normaliseParentId(query(event, "parentId"));
  const removed = await deleteKeys(deps.stores.values, parentId, [key]);
  if (!removed) throw new HttpError(404, `Key '${key}' not found for parentId: ${parentId}`);
  return json(200, { success: true, message: `Deleted '${key}' from parentId: ${parentId}` });
});

export const deleteBlob = route(["DELETE"], async (event, deps) => {
  requireAdmin(event, deps.env, deps.now());
  const parentId = normaliseParentId(query(event, "parentId"));
  await deleteNamespace(deps.stores.values, parentId);
  return json(200, { success: true, message: `Deleted all values for parentId: ${parentId}` });
});

// ---------- webhook registry (admin) ----------

export const getAllWebhooks = route(["GET"], async (event, deps) => {
  requireAdmin(event, deps.env, deps.now());
  const webhooks = await listWebhooks(deps.stores.webhooks);
  return json(200, { success: true, webhooks: webhooks.map(toPublic) });
});

export const getWebhook = route(["GET"], async (event, deps) => {
  requireAdmin(event, deps.env, deps.now());
  const webhook = await findWebhook(deps.stores.webhooks, requiredParentId(event, "getWebhook"));
  return json(200, { success: true, webhook: toPublic(webhook) });
});

export const saveWebhookHandler = route(["POST"], async (event, deps) => {
  requireAdmin(event, deps.env, deps.now());
  const { created, webhook } = await saveWebhook(deps.stores.webhooks, parseJsonBody(event));
  return json(created ? 201 : 200, {
    success: true,
    message: created ? "Webhook created" : "Webhook updated",
    webhook: toPublic(webhook)
  });
});

export const deleteWebhookHandler = route(["DELETE"], async (event, deps) => {
  requireAdmin(event, deps.env, deps.now());
  const parentId = requiredParentId(event, "deleteWebhook");
  await deleteWebhook(deps.stores.webhooks, parentId);
  return json(200, { success: true, message: `Webhook for parentId ${parentId} deleted` });
});

/** Send a synthetic payload to one webhook so an admin can check the agent end is listening. */
export const testWebhook = route(["POST"], async (event, deps) => {
  requireAdmin(event, deps.env, deps.now());
  const parentId = requiredParentId(event, "testWebhook");
  const webhook = await findWebhook(deps.stores.webhooks, parentId);
  if (!webhook.isActive) throw new HttpError(400, `Webhook for parentId: ${parentId} is not active`);

  const now = deps.now();
  const body = JSON.stringify({ test: true, timestamp: now.toISOString(), message: `Test webhook for ${parentId}`, parentId });
  const result = await forward(deps, webhook, body, { "X-Test-Webhook": "true" }, { maxAttempts: 1, timeoutMs: 5000, retryDelaysMs: [] });
  await appendDeliveryLog(deps.stores.webhooks, {
    timestamp: now.toISOString(),
    parentId,
    success: result.success,
    statusCode: result.statusCode,
    error: result.error ? `[test] ${result.error}` : undefined,
    payloadSize: Buffer.byteLength(body),
    responseTime: result.responseTime,
    attempts: result.attempts
  });
  await touchWebhook(deps.stores.webhooks, parentId, now);
  // 200 either way: the call worked, the payload says whether the target accepted it.
  return json(200, result.success
    ? { success: true, message: `Webhook test succeeded: ${result.statusCode}` }
    : { success: false, error: result.error, statusCode: result.statusCode });
});

export const getWebhookLogs = route(["GET"], async (event, deps) => {
  requireAdmin(event, deps.env, deps.now());
  const logs = await readDeliveryLogs(deps.stores.webhooks, requiredParentId(event, "getWebhookLogs"));
  return json(200, { success: true, logs });
});

export const getIncomingWebhookLogs = route(["GET"], async (event, deps) => {
  requireAdmin(event, deps.env, deps.now());
  return json(200, { success: true, logs: await readIncomingLogs(deps.stores.webhooks) });
});

// ---------- the public receiver WAHA posts to ----------

export const webhookReceiver = route(["POST"], async (event, deps) => {
  const outcome = await receiveWebhook(deps, event);
  return json(outcome.statusCode, outcome.body);
});

/** Function name -> handler. Used by the Netlify wrappers and the local server. */
export const handlers: Record<string, Handler> = {
  login,
  getValue: getValueHandler,
  getAllValues,
  getFilteredValues,
  getAllParentIds,
  saveValues: saveValuesHandler,
  deleteValue,
  deleteBlob,
  getAllWebhooks,
  getWebhook,
  saveWebhook: saveWebhookHandler,
  deleteWebhook: deleteWebhookHandler,
  testWebhook,
  getWebhookLogs,
  getIncomingWebhookLogs,
  webhookReceiver
};
