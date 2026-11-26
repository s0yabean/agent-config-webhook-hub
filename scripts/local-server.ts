// Local stand-in for `netlify dev`: one Node process on one port that serves
// the functions at /api/<name> and /.netlify/functions/<name>, a mock agent
// target at /mock-agent/<name>, and the Vite UI. No Netlify account needed.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createVite } from "vite";
import { defaultDeps } from "../src/server/deps";
import { handlers } from "../src/server/handlers";
import { resolveBackend } from "../src/server/store";
import { listWebhooks } from "../src/server/webhooks";
import type { FnEvent } from "../src/server/types";
import { seedStores } from "./seed-lib";

const PORT = Number(process.env.PORT || 8888);
const HOST = process.env.HOST || "127.0.0.1";

if (resolveBackend(process.env) === "netlify") {
  console.error("The local server runs the memory or file store. Unset STORE_BACKEND, or use `netlify dev` for Blobs.");
  process.exit(1);
}

const deps = defaultDeps();
if ((await listWebhooks(deps.stores.webhooks)).length === 0 && (await deps.stores.values.listKeys()).length === 0) {
  const counts = await seedStores(deps.stores);
  console.log(`Empty store: loaded synthetic seed (${counts.namespaces} namespaces, ${counts.webhooks} webhook routes).`);
}

/** What the mock agent targets received, newest first. */
const mockInbox: { at: string; target: string; headers: Record<string, string>; body: unknown }[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function handleMockAgent(req: IncomingMessage, res: ServerResponse, target: string) {
  if (req.method === "GET") return send(res, 200, { received: mockInbox });
  const raw = await readBody(req);
  if (target === "always-500") return send(res, 500, { error: "synthetic failure" });
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    /* keep raw text */
  }
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([k]) => k.startsWith("x-")).map(([k, v]) => [k, String(v)])
  );
  mockInbox.unshift({ at: new Date().toISOString(), target, headers, body });
  mockInbox.length = Math.min(mockInbox.length, 50);
  console.log(`[mock-agent/${target}] received ${raw.length} bytes`);
  return send(res, 200, { received: true, target });
}

const vite = await createVite({ server: { middlewareMode: true }, appType: "spa" });

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const fn = /^\/(?:api|\.netlify\/functions)\/([A-Za-z]+)(?:\/.*)?$/.exec(url.pathname);
  const mock = /^\/mock-agent(?:\/([A-Za-z0-9_-]+))?\/?$/.exec(url.pathname);

  try {
    if (fn) {
      const handler = handlers[fn[1]];
      if (!handler) return send(res, 404, { success: false, error: `No function named ${fn[1]}` });
      const event: FnEvent = {
        httpMethod: req.method || "GET",
        path: url.pathname,
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v])),
        queryStringParameters: Object.fromEntries(url.searchParams),
        body: (await readBody(req)) || null
      };
      const result = await handler(event, deps);
      res.writeHead(result.statusCode, result.headers);
      return res.end(result.body);
    }
    if (mock) return await handleMockAgent(req, res, mock[1] || "default");
    vite.middlewares(req, res);
  } catch (error) {
    console.error(error);
    send(res, 500, { success: false, error: "Local server error" });
  }
});

server.listen(PORT, HOST, () => {
  const auth = process.env.ADMIN_PASSWORD ? "password required" : "open (no ADMIN_PASSWORD set)";
  console.log(`agent-config-webhook-hub on http://${HOST}:${PORT}  store=${resolveBackend(process.env)}  admin=${auth}`);
  console.log(`  API:        http://${HOST}:${PORT}/api/<function>`);
  console.log(`  Receiver:   POST http://${HOST}:${PORT}/api/webhookReceiver`);
  console.log(`  Mock agent: http://${HOST}:${PORT}/mock-agent (GET shows what arrived)`);
});
