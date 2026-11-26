import { memoryStores } from "../src/server/store";
import type { Deps, FetchLike, FnEvent } from "../src/server/types";

export const NOW = new Date("2026-01-15T10:00:00.000Z");

export interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Fake fetch that replays a list of responses (a number is a status, an Error is thrown). */
export function fakeFetch(responses: (number | Error)[] = [200]) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return { ok: next >= 200 && next < 300, status: next, statusText: `status ${next}`, text: async () => `body ${next}` };
  };
  return { fetch, calls };
}

export function makeDeps(env: NodeJS.ProcessEnv = {}, fetch: FetchLike = fakeFetch().fetch): Deps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    stores: memoryStores(),
    env: { STORE_BACKEND: "memory", ...env },
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => NOW,
    sleeps
  };
}

export function ev(
  method: string,
  path: string,
  opts: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {}
): FnEvent {
  return {
    httpMethod: method,
    path,
    headers: opts.headers || {},
    queryStringParameters: opts.query || {},
    body: opts.body === undefined ? null : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)
  };
}

export function parse(result: { body: string }) {
  return JSON.parse(result.body) as Record<string, any>;
}

/** A WAHA-style "message" event from a synthetic sender. */
export function wahaMessage(from: string, text = "hello (synthetic)") {
  return { event: "message", session: "default", payload: { id: "synthetic-1", from, fromMe: false, body: text } };
}
