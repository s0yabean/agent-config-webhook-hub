import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HttpError, header } from "./http";
import { resolveBackend } from "./store";
import type { FnEvent } from "./types";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Constant-time string comparison that also works for different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function sessionSecret(env: NodeJS.ProcessEnv): string {
  return env.SESSION_SECRET || `pw:${env.ADMIN_PASSWORD ?? ""}`;
}

function sign(env: NodeJS.ProcessEnv, exp: number): string {
  return createHmac("sha256", sessionSecret(env)).update(`admin:${exp}`).digest("base64url");
}

/**
 * True when admin routes need a token. Without ADMIN_PASSWORD the app only
 * runs open on the local backends; on Netlify it refuses admin calls instead.
 */
export function authRequired(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.ADMIN_PASSWORD) || resolveBackend(env) === "netlify";
}

export function checkPassword(env: NodeJS.ProcessEnv, password: unknown): boolean {
  const expected = env.ADMIN_PASSWORD;
  if (!expected || typeof password !== "string") return false;
  return safeEqual(password, expected);
}

export function issueToken(env: NodeJS.ProcessEnv, now: Date): { token: string; expiresAt: string } {
  const exp = now.getTime() + SESSION_TTL_MS;
  return { token: `${exp}.${sign(env, exp)}`, expiresAt: new Date(exp).toISOString() };
}

export function verifyToken(env: NodeJS.ProcessEnv, token: string | undefined, now: Date): boolean {
  if (!token || !env.ADMIN_PASSWORD) return false;
  const [expRaw, sig] = token.split(".");
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || !sig || exp <= now.getTime()) return false;
  return safeEqual(sig, sign(env, exp));
}

function bearer(event: FnEvent): string | undefined {
  const value = header(event, "authorization");
  return value?.startsWith("Bearer ") ? value.slice(7).trim() : undefined;
}

/** Admin routes: the panel (edit config, manage webhooks, read logs). */
export function requireAdmin(event: FnEvent, env: NodeJS.ProcessEnv, now: Date): void {
  if (!authRequired(env)) return;
  if (!env.ADMIN_PASSWORD) {
    throw new HttpError(503, "ADMIN_PASSWORD is not set, so admin routes are disabled");
  }
  if (!verifyToken(env, bearer(event), now)) {
    throw new HttpError(401, "Admin login required");
  }
}

/**
 * Read routes that agent workflows call. An admin token always works. When
 * AGENT_API_KEY is set, agents must send it as X-Api-Key; when it is not set,
 * reads stay open, as in the original deployment.
 */
export function requireReader(event: FnEvent, env: NodeJS.ProcessEnv, now: Date): void {
  if (verifyToken(env, bearer(event), now)) return;
  const key = env.AGENT_API_KEY;
  if (!key) return;
  const sent = header(event, "x-api-key");
  if (!sent || !safeEqual(sent, key)) throw new HttpError(401, "Missing or invalid X-Api-Key");
}
