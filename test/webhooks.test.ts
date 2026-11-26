import { describe, expect, it } from "vitest";
import { handlers } from "../src/server/handlers";
import { validateWebhook } from "../src/server/webhooks";
import { ev, fakeFetch, makeDeps, parse } from "./helpers";

const route = (over: Record<string, unknown> = {}) => ({
  parentId: "support-bot",
  sender_id: "15550100001@c.us",
  webhookUrl: "https://agent.example.com/hook",
  isActive: true,
  ...over
});

const saveRoute = (deps: ReturnType<typeof makeDeps>, body: unknown) =>
  handlers.saveWebhook(ev("POST", "/api/saveWebhook", { body }), deps);

describe("validateWebhook", () => {
  it("requires parentId, a valid http(s) URL and a WAHA chat ID", () => {
    expect(() => validateWebhook(route({ parentId: "" }))).toThrow(/parentId/);
    expect(() => validateWebhook(route({ webhookUrl: "not a url" }))).toThrow(/Invalid webhook URL/);
    expect(() => validateWebhook(route({ webhookUrl: "ftp://example.com" }))).toThrow(/http or https/);
    expect(() => validateWebhook(route({ sender_id: undefined }))).toThrow(/sender_id is required/);
    expect(() => validateWebhook(route({ sender_id: "15550100001" }))).toThrow(/@c.us/);
    expect(validateWebhook(route({ sender_id: "15550100009@g.us" })).sender_id).toBe("15550100009@g.us");
  });

  it("defaults isActive to true and rejects non-string headers", () => {
    expect(validateWebhook(route({ isActive: undefined })).isActive).toBe(true);
    expect(() => validateWebhook(route({ headers: { "X-N": 1 } }))).toThrow(/must be a string/);
  });
});

describe("webhook registry routes", () => {
  it("creates (201), lists, gets and updates (200) a route", async () => {
    const deps = makeDeps();
    expect((await saveRoute(deps, route())).statusCode).toBe(201);
    const updated = await saveRoute(deps, route({ description: "v2" }));
    expect(updated.statusCode).toBe(200);

    const list = parse(await handlers.getAllWebhooks(ev("GET", "/api/getAllWebhooks"), deps)).webhooks;
    expect(list).toHaveLength(1);
    expect(list[0].description).toBe("v2");

    const one = await handlers.getWebhook(ev("GET", "/api/getWebhook/support-bot"), deps);
    expect(parse(one).webhook.parentId).toBe("support-bot");
    expect((await handlers.getWebhook(ev("GET", "/api/getWebhook/missing"), deps)).statusCode).toBe(404);
  });

  it("never returns the secret, and keeps it when an update omits it", async () => {
    const deps = makeDeps();
    await saveRoute(deps, route({ secret: "route-secret-test-only" }));
    const listed = parse(await handlers.getAllWebhooks(ev("GET", "/api/getAllWebhooks"), deps)).webhooks[0];
    expect(listed.secret).toBeUndefined();
    expect(listed.hasSecret).toBe(true);

    await saveRoute(deps, route({ description: "no secret field" }));
    expect(parse(await handlers.getWebhook(ev("GET", "/api/getWebhook/support-bot"), deps)).webhook.hasSecret).toBe(true);

    await saveRoute(deps, route({ secret: "" }));
    expect(parse(await handlers.getWebhook(ev("GET", "/api/getWebhook/support-bot"), deps)).webhook.hasSecret).toBe(false);
  });

  it("refuses two active routes for the same sender (409), but allows a paused duplicate", async () => {
    const deps = makeDeps();
    await saveRoute(deps, route());
    const clash = await saveRoute(deps, route({ parentId: "other-bot" }));
    expect(clash.statusCode).toBe(409);
    expect((await saveRoute(deps, route({ parentId: "other-bot", isActive: false }))).statusCode).toBe(201);
  });

  it("deletes a route and 404s on a second delete", async () => {
    const deps = makeDeps();
    await saveRoute(deps, route());
    expect((await handlers.deleteWebhook(ev("DELETE", "/api/deleteWebhook/support-bot"), deps)).statusCode).toBe(200);
    expect((await handlers.deleteWebhook(ev("DELETE", "/api/deleteWebhook/support-bot"), deps)).statusCode).toBe(404);
  });
});

describe("testWebhook", () => {
  it("sends one test payload, records the delivery and updates lastUsed", async () => {
    const { fetch, calls } = fakeFetch([200]);
    const deps = makeDeps({}, fetch);
    await saveRoute(deps, route({ headers: { "X-Agent-Name": "support-bot" } }));

    const res = await handlers.testWebhook(ev("POST", "/api/testWebhook/support-bot"), deps);
    expect(parse(res)).toMatchObject({ success: true });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body)).toMatchObject({ test: true, parentId: "support-bot" });
    expect(calls[0].headers["X-Test-Webhook"]).toBe("true");
    expect(calls[0].headers["X-Agent-Name"]).toBe("support-bot");

    const logs = parse(await handlers.getWebhookLogs(ev("GET", "/api/getWebhookLogs/support-bot"), deps)).logs;
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ success: true, statusCode: 200, attempts: 1 });
    const hook = parse(await handlers.getWebhook(ev("GET", "/api/getWebhook/support-bot"), deps)).webhook;
    expect(hook.lastUsed).toBe("2026-01-15T10:00:00.000Z");
  });

  it("reports a failing target with 200 + success:false, without retrying", async () => {
    const { fetch, calls } = fakeFetch([500]);
    const deps = makeDeps({}, fetch);
    await saveRoute(deps, route());
    const res = await handlers.testWebhook(ev("POST", "/api/testWebhook/support-bot"), deps);
    expect(res.statusCode).toBe(200);
    expect(parse(res)).toMatchObject({ success: false, statusCode: 500 });
    expect(calls).toHaveLength(1);
  });

  it("refuses to test a paused route", async () => {
    const deps = makeDeps();
    await saveRoute(deps, route({ isActive: false }));
    expect((await handlers.testWebhook(ev("POST", "/api/testWebhook/support-bot"), deps)).statusCode).toBe(400);
  });
});
