// Browser client for the functions. Same-origin /api/* in both setups:
// netlify.toml redirects it on Netlify, scripts/local-server.ts serves it locally.

export interface WebhookView {
  parentId: string;
  webhookUrl: string;
  sender_id: string;
  description?: string;
  isActive: boolean;
  lastUsed?: string;
  headers?: Record<string, string>;
  hasSecret: boolean;
}

export interface WebhookInput {
  parentId: string;
  webhookUrl: string;
  sender_id: string;
  description?: string;
  isActive: boolean;
  headers?: Record<string, string>;
  secret?: string;
}

export interface DeliveryLog {
  timestamp: string;
  parentId: string;
  success: boolean;
  statusCode?: number;
  error?: string;
  payloadSize: number;
  responseTime: number;
  attempts: number;
}

export interface IncomingLog {
  timestamp: string;
  sender_id: string;
  event_type: string;
  raw_payload: unknown;
  determined_parent_id: string | null;
  status: "forwarded" | "rejected" | "failed";
  reason?: string;
}

const TOKEN_KEY = "hub-admin-token";

function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: the session lasts until reload */
  }
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function call<T>(name: string, opts: { method?: string; query?: Record<string, string>; body?: unknown; path?: string } = {}): Promise<T> {
  const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : "";
  const path = opts.path ? `/${encodeURIComponent(opts.path)}` : "";
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`/api/${name}${path}${qs}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string } & T;
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  authStatus: () => call<{ authRequired: boolean }>("login"),
  login: (password: string) => call<{ token: string; expiresAt: string }>("login", { method: "POST", body: { password } }),

  parentIds: () => call<{ parentIds: string[] }>("getAllParentIds"),
  values: (parentId: string) => call<{ pairs: Record<string, string> }>("getAllValues", { query: { parentId } }),
  filtered: (parentId: string, terms: string) =>
    call<{ pairs: Record<string, string> }>("getFilteredValues", { query: { parentId, searchTerms: terms } }),
  save: (parentId: string, pairs: Record<string, string>, mode: "merge" | "replace" = "merge") =>
    call<{ message: string }>("saveValues", { method: "POST", body: { parentId, pairs, mode } }),
  deleteKey: (parentId: string, key: string) => call("deleteValue", { method: "DELETE", query: { parentId, key } }),
  deleteNamespace: (parentId: string) => call("deleteBlob", { method: "DELETE", query: { parentId } }),

  webhooks: () => call<{ webhooks: WebhookView[] }>("getAllWebhooks"),
  saveWebhook: (webhook: WebhookInput) => call<{ message: string }>("saveWebhook", { method: "POST", body: webhook }),
  deleteWebhook: (parentId: string) => call("deleteWebhook", { method: "DELETE", path: parentId }),
  testWebhook: (parentId: string) =>
    call<{ success: boolean; message?: string; error?: string }>("testWebhook", { method: "POST", path: parentId }),
  deliveryLogs: (parentId: string) => call<{ logs: DeliveryLog[] }>("getWebhookLogs", { path: parentId }),
  incomingLogs: () => call<{ logs: IncomingLog[] }>("getIncomingWebhookLogs")
};
