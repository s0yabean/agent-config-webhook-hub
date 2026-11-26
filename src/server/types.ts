import type { Stores } from "./store";

/** The parts of a Netlify Functions (Lambda-compatible) event the handlers read. */
export interface FnEvent {
  httpMethod: string;
  path: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body: string | null;
  isBase64Encoded?: boolean;
}

export interface FnResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;

/** Everything a handler needs from the outside world, so tests can swap it. */
export interface Deps {
  stores: Stores;
  env: NodeJS.ProcessEnv;
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

export type Pairs = Record<string, string>;

/** Where messages from one WhatsApp sender are forwarded. */
export interface WebhookMapping {
  parentId: string;
  webhookUrl: string;
  sender_id: string;
  description?: string;
  isActive: boolean;
  lastUsed?: string;
  headers?: Record<string, string>;
  /** Used to sign forwarded requests (X-Webhook-Signature, HMAC-SHA256). */
  secret?: string;
}

/** One forward attempt to an agent workflow, kept per parentId. */
export interface DeliveryLogEntry {
  timestamp: string;
  parentId: string;
  success: boolean;
  statusCode?: number;
  error?: string;
  payloadSize: number;
  responseTime: number;
  attempts: number;
}

export type IncomingStatus = "forwarded" | "rejected" | "failed";

/** One entry per request that reached the receiver, whatever happened to it. */
export interface IncomingWebhookLog {
  timestamp: string;
  sender_id: string;
  event_type: string;
  raw_payload: unknown;
  determined_parent_id: string | null;
  status: IncomingStatus;
  reason?: string;
}
