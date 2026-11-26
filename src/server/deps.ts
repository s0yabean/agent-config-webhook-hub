import { createStores, resolveBackend, type Stores } from "./store";
import type { Deps, FetchLike } from "./types";

let cached: Stores | null = null;

function stores(env: NodeJS.ProcessEnv): Stores {
  // Netlify Blobs clients pick up per-invocation credentials, so build them
  // fresh each call there. Local stores are cached so the memory backend persists.
  if (resolveBackend(env) === "netlify") return createStores(env);
  cached ??= createStores(env);
  return cached;
}

/** Real dependencies: stores chosen by STORE_BACKEND, global fetch, real timers. */
export function defaultDeps(env: NodeJS.ProcessEnv = process.env): Deps {
  return {
    stores: stores(env),
    env,
    fetch: globalThis.fetch as unknown as FetchLike,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date()
  };
}
