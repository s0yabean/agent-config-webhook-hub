import { connectLambda } from "@netlify/blobs";
import { defaultDeps } from "./deps";
import { handlers } from "./handlers";
import type { FnEvent, FnResult } from "./types";

/**
 * Wrap a handler as a Netlify Function (Lambda-compatible signature).
 * Without SITE_ID / NETLIFY_AUTH_TOKEN, Netlify Blobs takes its credentials
 * from the event, which connectLambda wires up.
 */
export function netlifyHandler(name: keyof typeof handlers) {
  return async (event: FnEvent & { blobs?: string }): Promise<FnResult> => {
    if (event.blobs) connectLambda(event as unknown as Parameters<typeof connectLambda>[0]);
    return handlers[name](event, defaultDeps());
  };
}
