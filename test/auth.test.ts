import { describe, expect, it } from "vitest";
import { checkPassword, issueToken, safeEqual, verifyToken } from "../src/server/auth";
import { handlers } from "../src/server/handlers";
import { NOW, ev, makeDeps, parse } from "./helpers";

const ENV = { ADMIN_PASSWORD: "correct horse (test only)" };

async function loginToken(deps: ReturnType<typeof makeDeps>) {
  const res = await handlers.login(ev("POST", "/api/login", { body: { password: ENV.ADMIN_PASSWORD } }), deps);
  return parse(res).token as string;
}

describe("password check", () => {
  it("compares in constant time, including different lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(checkPassword(ENV, ENV.ADMIN_PASSWORD)).toBe(true);
    expect(checkPassword(ENV, "wrong")).toBe(false);
    expect(checkPassword(ENV, 123)).toBe(false);
    expect(checkPassword({}, "")).toBe(false);
  });

  it("issues tokens that expire and cannot be forged", () => {
    const { token } = issueToken(ENV, NOW);
    expect(verifyToken(ENV, token, NOW)).toBe(true);
    expect(verifyToken(ENV, token, new Date(NOW.getTime() + 13 * 3600 * 1000))).toBe(false);
    const [exp] = token.split(".");
    expect(verifyToken(ENV, `${Number(exp) + 1000}.${token.split(".")[1]}`, NOW)).toBe(false);
    expect(verifyToken({ ADMIN_PASSWORD: "different" }, token, NOW)).toBe(false);
  });
});

describe("login route", () => {
  it("reports whether a password is needed", async () => {
    expect(parse(await handlers.login(ev("GET", "/api/login"), makeDeps())).authRequired).toBe(false);
    expect(parse(await handlers.login(ev("GET", "/api/login"), makeDeps(ENV))).authRequired).toBe(true);
  });

  it("returns 401 for a wrong password and a token for the right one", async () => {
    const deps = makeDeps(ENV);
    const bad = await handlers.login(ev("POST", "/api/login", { body: { password: "nope" } }), deps);
    expect(bad.statusCode).toBe(401);
    const token = await loginToken(deps);
    expect(token).toMatch(/^\d+\.[\w-]+$/);
  });
});

describe("admin and reader guards", () => {
  it("leaves admin routes open locally when no password is set", async () => {
    const res = await handlers.saveValues(ev("POST", "/api/saveValues", { body: { pairs: { a: "1" } } }), makeDeps());
    expect(res.statusCode).toBe(200);
  });

  it("requires a valid bearer token once ADMIN_PASSWORD is set", async () => {
    const deps = makeDeps(ENV);
    const body = { pairs: { a: "1" } };
    expect((await handlers.saveValues(ev("POST", "/api/saveValues", { body }), deps)).statusCode).toBe(401);
    expect(
      (await handlers.saveValues(ev("POST", "/api/saveValues", { body, headers: { Authorization: "Bearer 1.bogus" } }), deps)).statusCode
    ).toBe(401);
    const token = await loginToken(deps);
    const ok = await handlers.saveValues(ev("POST", "/api/saveValues", { body, headers: { authorization: `Bearer ${token}` } }), deps);
    expect(ok.statusCode).toBe(200);
    expect((await handlers.getIncomingWebhookLogs(ev("GET", "/api/getIncomingWebhookLogs"), deps)).statusCode).toBe(401);
  });

  it("refuses admin routes on the Netlify backend until a password is set", async () => {
    const deps = makeDeps({ STORE_BACKEND: "netlify" });
    const res = await handlers.getAllWebhooks(ev("GET", "/api/getAllWebhooks"), deps);
    expect(res.statusCode).toBe(503);
  });

  it("keeps reads open without AGENT_API_KEY, and enforces it when set", async () => {
    const open = makeDeps(ENV);
    expect((await handlers.getAllValues(ev("GET", "/api/getAllValues"), open)).statusCode).toBe(200);

    const keyed = makeDeps({ ...ENV, AGENT_API_KEY: "agent-key-test-only" });
    expect((await handlers.getAllValues(ev("GET", "/api/getAllValues"), keyed)).statusCode).toBe(401);
    expect(
      (await handlers.getAllValues(ev("GET", "/api/getAllValues", { headers: { "X-Api-Key": "wrong" } }), keyed)).statusCode
    ).toBe(401);
    expect(
      (await handlers.getAllValues(ev("GET", "/api/getAllValues", { headers: { "x-api-key": "agent-key-test-only" } }), keyed)).statusCode
    ).toBe(200);
    const token = await loginToken(keyed);
    expect(
      (await handlers.getAllValues(ev("GET", "/api/getAllValues", { headers: { Authorization: `Bearer ${token}` } }), keyed)).statusCode
    ).toBe(200);
  });

  it("never lets the agent key write", async () => {
    const deps = makeDeps({ ...ENV, AGENT_API_KEY: "agent-key-test-only" });
    const res = await handlers.saveValues(
      ev("POST", "/api/saveValues", { body: { pairs: { a: "1" } }, headers: { "x-api-key": "agent-key-test-only" } }),
      deps
    );
    expect(res.statusCode).toBe(401);
  });
});
