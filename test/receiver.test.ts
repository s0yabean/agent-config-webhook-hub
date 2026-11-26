import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handlers } from "../src/server/handlers";
import { extractSenderId, forward, outboundSignature } from "../src/server/receiver";
import { LOG_LIMIT, saveWebhook } from "../src/server/webhooks";
import type { WebhookMapping } from "../src/server/types";
import { ev, fakeFetch, makeDeps, parse, wahaMessage } from "./helpers";

const SUPPORT = "15550100001@c.us";

async function withRoutes(deps: ReturnType<typeof makeDeps>) {
  await saveWebhook(deps.stores.webhooks, {
    parentId: "support-bot",
    sender_id: SUPPORT,
    webhookUrl: "https://agent.example.com/support",
    isActive: true,
    secret: "route-secret-test-only",
    headers: { "X-Agent-Name": "support-bot" }
  });
  await saveWebhook(deps.stores.webhooks, {
    parentId: "paused-bot",
    sender_id: "15550100004@c.us",
    webhookUrl: "https://agent.example.com/paused",
    isActive: false
  });
}

const receive = (deps: ReturnType<typeof makeDeps>, body: unknown, headers: Record<string, string> = {}) =>
  handlers.webhookReceiver(ev("POST", "/api/webhookReceiver", { body, headers }), deps);

const incoming = async (deps: ReturnType<typeof makeDeps>) =>
  parse(await handlers.getIncomingWebhookLogs(ev("GET", "/api/getIncomingWebhookLogs"), deps)).logs;

describe("extractSenderId", () => {
  it("reads WAHA message events and the alternative sender shape", () => {
    expect(extractSenderId(wahaMessage(SUPPORT))).toBe(SUPPORT);
    expect(extractSenderId({ sender: { attendee_provider_id: SUPPORT } })).toBe(SUPPORT);
    expect(extractSenderId({ event: "session.status", payload: { status: "WORKING" } })).toBeNull();
    expect(extractSenderId(null)).toBeNull();
  });
});

describe("forward", () => {
  const hook: WebhookMapping = { parentId: "p", sender_id: SUPPORT, webhookUrl: "https://agent.example.com/x", isActive: true };
  const policy = { maxAttempts: 3, timeoutMs: 1000, retryDelaysMs: [10, 20] };

  it("retries 5xx and network errors, then succeeds", async () => {
    const { fetch, calls } = fakeFetch([503, new Error("ECONNRESET"), 200]);
    const deps = makeDeps({}, fetch);
    const r = await forward(deps, hook, "{}", {}, policy);
    expect(r).toMatchObject({ success: true, attempts: 3, statusCode: 200 });
    expect(calls).toHaveLength(3);
    expect(deps.sleeps).toEqual([10, 20]);
  });

  it("does not retry a 4xx", async () => {
    const { fetch, calls } = fakeFetch([400, 200]);
    const r = await forward(makeDeps({}, fetch), hook, "{}", {}, policy);
    expect(r).toMatchObject({ success: false, attempts: 1, statusCode: 400 });
    expect(calls).toHaveLength(1);
  });

  it("gives up after the last attempt with the last error", async () => {
    const { fetch } = fakeFetch([500]);
    const r = await forward(makeDeps({}, fetch), hook, "{}", {}, policy);
    expect(r.success).toBe(false);
    expect(r.attempts).toBe(3);
    expect(r.error).toMatch(/All 3 attempts failed.*500/);
  });
});

describe("webhookReceiver", () => {
  it("forwards a matching sender's raw body with custom headers and a valid signature", async () => {
    const { fetch, calls } = fakeFetch([200]);
    const deps = makeDeps({}, fetch);
    await withRoutes(deps);
    const body = JSON.stringify(wahaMessage(SUPPORT));

    const res = await receive(deps, body);
    expect(res.statusCode).toBe(200);
    expect(parse(res)).toEqual({ success: true, parentId: "support-bot", attempts: 1 });

    expect(calls[0].url).toBe("https://agent.example.com/support");
    expect(calls[0].body).toBe(body);
    expect(calls[0].headers["X-Agent-Name"]).toBe("support-bot");
    expect(calls[0].headers["X-Webhook-Signature"]).toBe(outboundSignature(body, "route-secret-test-only"));

    const logs = await incoming(deps);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: "forwarded", sender_id: SUPPORT, event_type: "message", determined_parent_id: "support-bot" });
    expect(logs[0].raw_payload.payload.body).toBe("hello (synthetic)");

    const deliveries = parse(await handlers.getWebhookLogs(ev("GET", "/api/getWebhookLogs/support-bot"), deps)).logs;
    expect(deliveries[0]).toMatchObject({ success: true, statusCode: 200, payloadSize: Buffer.byteLength(body) });
  });

  it("rejects unknown and paused senders with 403 and logs why", async () => {
    const { fetch, calls } = fakeFetch([200]);
    const deps = makeDeps({}, fetch);
    await withRoutes(deps);

    expect((await receive(deps, wahaMessage("15550109999@c.us"))).statusCode).toBe(403);
    expect((await receive(deps, wahaMessage("15550100004@c.us"))).statusCode).toBe(403);
    expect(calls).toHaveLength(0);

    const logs = await incoming(deps);
    expect(logs.map((l: any) => l.status)).toEqual(["rejected", "rejected"]);
    expect(logs[0].reason).toMatch(/No matching webhook/);
  });

  it("rejects events with no sender, empty bodies and invalid JSON, logging each", async () => {
    const deps = makeDeps();
    expect((await receive(deps, { event: "session.status" })).statusCode).toBe(403);
    expect((await handlers.webhookReceiver(ev("POST", "/api/webhookReceiver"), deps)).statusCode).toBe(400);
    expect((await receive(deps, "{oops")).statusCode).toBe(400);
    const reasons = (await incoming(deps)).map((l: any) => l.reason);
    expect(reasons).toEqual(["Invalid JSON in request body", "Request body is required", "No sender ID in payload"]);
  });

  it("returns 502 and logs 'failed' when the agent target keeps failing", async () => {
    const { fetch, calls } = fakeFetch([500]);
    const deps = makeDeps({}, fetch);
    await withRoutes(deps);
    const res = await receive(deps, wahaMessage(SUPPORT));
    expect(res.statusCode).toBe(502);
    expect(calls).toHaveLength(3);
    const [log] = await incoming(deps);
    expect(log).toMatchObject({ status: "failed", determined_parent_id: "support-bot" });
    const [delivery] = parse(await handlers.getWebhookLogs(ev("GET", "/api/getWebhookLogs/support-bot"), deps)).logs;
    expect(delivery).toMatchObject({ success: false, attempts: 3, statusCode: 500 });
  });

  it("requires a valid X-Webhook-Hmac when INBOUND_HMAC_SECRET is set", async () => {
    const secret = "inbound-secret-test-only";
    const { fetch } = fakeFetch([200]);
    const deps = makeDeps({ INBOUND_HMAC_SECRET: secret }, fetch);
    await withRoutes(deps);
    const body = JSON.stringify(wahaMessage(SUPPORT));

    expect((await receive(deps, body)).statusCode).toBe(401);
    expect((await receive(deps, body, { "X-Webhook-Hmac": "00" })).statusCode).toBe(401);
    const good = createHmac("sha512", secret).update(body).digest("hex");
    expect((await receive(deps, body, { "x-webhook-hmac": good })).statusCode).toBe(200);

    const logs = await incoming(deps);
    expect(logs[2].raw_payload).toMatch(/not logged/);
  });

  it("can keep message text out of the log", async () => {
    const deps = makeDeps({ LOG_RAW_PAYLOADS: "false" });
    await receive(deps, wahaMessage("15550109999@c.us", "private text"));
    const [log] = await incoming(deps);
    expect(JSON.stringify(log)).not.toContain("private text");
  });

  it(`keeps only the newest ${LOG_LIMIT} incoming entries`, async () => {
    const deps = makeDeps();
    for (let i = 0; i < LOG_LIMIT + 5; i++) {
      await receive(deps, wahaMessage(`1555010${String(i).padStart(4, "0")}@c.us`));
    }
    const logs = await incoming(deps);
    expect(logs).toHaveLength(LOG_LIMIT);
    expect(logs[0].sender_id).toBe(`1555010${String(LOG_LIMIT + 4).padStart(4, "0")}@c.us`);
  });
});
