import { describe, expect, it } from "vitest";
import { handlers } from "../src/server/handlers";
import { filterPairs, mergePairs, parseSearchTerms } from "../src/server/values";
import { ev, makeDeps, parse } from "./helpers";

const save = (deps: ReturnType<typeof makeDeps>, body: unknown) =>
  handlers.saveValues(ev("POST", "/api/saveValues", { body }), deps);

describe("mergePairs", () => {
  it("counts added, updated and unchanged keys and keeps the rest in merge mode", () => {
    const r = mergePairs({ a: "1", b: "2", c: "3" }, { a: "1", b: "20", d: "4" }, "merge");
    expect(r.pairs).toEqual({ a: "1", b: "20", c: "3", d: "4" });
    expect([r.added, r.updated, r.unchanged, r.removed]).toEqual([1, 1, 1, 0]);
  });

  it("drops keys that were not sent in replace mode", () => {
    const r = mergePairs({ a: "1", b: "2" }, { a: "1" }, "replace");
    expect(r.pairs).toEqual({ a: "1" });
    expect(r.removed).toBe(1);
  });
});

describe("filterPairs", () => {
  const pairs = { k1: "Refund in progress", k2: "Wholesale enquiry", k3: "New lead" };

  it("matches any term, case-insensitively, on values", () => {
    expect(filterPairs(pairs, ["REFUND", "wholesale"])).toEqual({ k1: pairs.k1, k2: pairs.k2 });
  });

  it("does not match on keys", () => {
    expect(filterPairs(pairs, ["k1"])).toEqual({});
  });

  it("returns everything when there are no usable terms", () => {
    expect(filterPairs(pairs, parseSearchTerms(" , ,"))).toEqual(pairs);
  });
});

describe("config value routes", () => {
  it("saves, reads one value and reads the whole namespace", async () => {
    const deps = makeDeps();
    const saved = await save(deps, { parentId: "support-bot", pairs: { tone: "short", max_reply_chars: "600" } });
    expect(saved.statusCode).toBe(200);
    expect(parse(saved)).toMatchObject({ added: 2, updated: 0 });

    const one = await handlers.getValue(ev("GET", "/api/getValue", { query: { parentId: "support-bot", key: "tone" } }), deps);
    expect(parse(one)).toEqual({ success: true, value: "short" });

    const all = await handlers.getAllValues(ev("GET", "/api/getAllValues", { query: { parentId: "support-bot" } }), deps);
    expect(parse(all).pairs).toEqual({ tone: "short", max_reply_chars: "600" });
  });

  it("accepts the key as a path segment", async () => {
    const deps = makeDeps();
    await save(deps, { pairs: { greeting: "hi" } });
    const res = await handlers.getValue(ev("GET", "/.netlify/functions/getValue/greeting"), deps);
    expect(parse(res).value).toBe("hi");
  });

  it("keeps namespaces separate and defaults to 'default'", async () => {
    const deps = makeDeps();
    await save(deps, { pairs: { lang: "en" } });
    await save(deps, { parentId: "booking-bot", pairs: { lang: "ms" } });
    const def = await handlers.getValue(ev("GET", "/api/getValue", { query: { key: "lang" } }), deps);
    const other = await handlers.getValue(ev("GET", "/api/getValue", { query: { key: "lang", parentId: "booking-bot" } }), deps);
    expect(parse(def).value).toBe("en");
    expect(parse(other).value).toBe("ms");
  });

  it("finds a key whose value is an empty string (the original treated it as missing)", async () => {
    const deps = makeDeps();
    await save(deps, { pairs: { suffix: "" } });
    const res = await handlers.getValue(ev("GET", "/api/getValue", { query: { key: "suffix" } }), deps);
    expect(res.statusCode).toBe(200);
    expect(parse(res).value).toBe("");
  });

  it("returns 404 for a missing namespace and for a missing key", async () => {
    const deps = makeDeps();
    const noNs = await handlers.getValue(ev("GET", "/api/getValue", { query: { key: "x", parentId: "nope" } }), deps);
    expect(noNs.statusCode).toBe(404);
    await save(deps, { pairs: { a: "1" } });
    const noKey = await handlers.getValue(ev("GET", "/api/getValue", { query: { key: "x" } }), deps);
    expect(noKey.statusCode).toBe(404);
    expect(parse(noKey).error).toMatch(/Key 'x' not found/);
  });

  it("merges by default and replaces when asked", async () => {
    const deps = makeDeps();
    await save(deps, { pairs: { a: "1", b: "2" } });
    await save(deps, { pairs: { b: "3" } });
    let all = parse(await handlers.getAllValues(ev("GET", "/api/getAllValues"), deps));
    expect(all.pairs).toEqual({ a: "1", b: "3" });

    const replaced = parse(await save(deps, { pairs: { c: "4" }, mode: "replace" }));
    expect(replaced.removed).toBe(2);
    all = parse(await handlers.getAllValues(ev("GET", "/api/getAllValues"), deps));
    expect(all.pairs).toEqual({ c: "4" });
  });

  it("filters values the way an agent would query them", async () => {
    const deps = makeDeps();
    await save(deps, {
      parentId: "contacts-demo",
      pairs: { "15550100101@c.us": "Alex (synthetic) - refund", "15550100102@c.us": "Priya (synthetic) - wholesale" }
    });
    const res = await handlers.getFilteredValues(
      ev("GET", "/api/getFilteredValues", { query: { parentId: "contacts-demo", searchTerms: " Refund ," } }),
      deps
    );
    expect(Object.keys(parse(res).pairs)).toEqual(["15550100101@c.us"]);
  });

  it("deletes a single key, and 404s when it is not there", async () => {
    const deps = makeDeps();
    await save(deps, { pairs: { a: "1", b: "2" } });
    const del = await handlers.deleteValue(ev("DELETE", "/api/deleteValue", { query: { key: "a" } }), deps);
    expect(del.statusCode).toBe(200);
    expect(parse(await handlers.getAllValues(ev("GET", "/api/getAllValues"), deps)).pairs).toEqual({ b: "2" });
    const again = await handlers.deleteValue(ev("DELETE", "/api/deleteValue", { query: { key: "a" } }), deps);
    expect(again.statusCode).toBe(404);
  });

  it("deletes a whole namespace and lists parent IDs with default first", async () => {
    const deps = makeDeps();
    await save(deps, { parentId: "zeta", pairs: { a: "1" } });
    await save(deps, { parentId: "alpha", pairs: { a: "1" } });
    let ids = parse(await handlers.getAllParentIds(ev("GET", "/api/getAllParentIds"), deps)).parentIds;
    expect(ids).toEqual(["default", "alpha", "zeta"]);

    await handlers.deleteBlob(ev("DELETE", "/api/deleteBlob", { query: { parentId: "zeta" } }), deps);
    ids = parse(await handlers.getAllParentIds(ev("GET", "/api/getAllParentIds"), deps)).parentIds;
    expect(ids).toEqual(["default", "alpha"]);
  });

  it("rejects non-string values, bad parentIds, bad modes and bad JSON with 400", async () => {
    const deps = makeDeps();
    expect((await save(deps, { pairs: { a: 1 } })).statusCode).toBe(400);
    expect((await save(deps, { pairs: ["a"] })).statusCode).toBe(400);
    expect((await save(deps, { pairs: { a: "1" }, parentId: "../etc" })).statusCode).toBe(400);
    expect((await save(deps, { pairs: { a: "1" }, mode: "overwrite" })).statusCode).toBe(400);
    expect((await save(deps, "{not json")).statusCode).toBe(400);
  });

  it("answers CORS preflight and rejects the wrong method", async () => {
    const deps = makeDeps();
    expect((await handlers.saveValues(ev("OPTIONS", "/api/saveValues"), deps)).statusCode).toBe(204);
    expect((await handlers.saveValues(ev("GET", "/api/saveValues"), deps)).statusCode).toBe(405);
  });
});
