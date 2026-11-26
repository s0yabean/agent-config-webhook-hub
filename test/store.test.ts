import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore, MemoryStore, createStores, resolveBackend } from "../src/server/store";
import { seedStores } from "../scripts/seed-lib";
import { listWebhooks } from "../src/server/webhooks";
import { readPairs } from "../src/server/values";

let dir: string | null = null;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe("resolveBackend", () => {
  it("defaults to file locally and netlify on Netlify, and rejects unknown names", () => {
    expect(resolveBackend({})).toBe("file");
    expect(resolveBackend({ NETLIFY: "true" })).toBe("netlify");
    expect(resolveBackend({ STORE_BACKEND: "Memory" })).toBe("memory");
    expect(() => resolveBackend({ STORE_BACKEND: "redis" })).toThrow(/Unknown STORE_BACKEND/);
  });
});

describe.each([
  ["MemoryStore", async () => new MemoryStore()],
  ["FileStore", async () => {
    dir = await mkdtemp(join(tmpdir(), "hub-store-"));
    return new FileStore(join(dir, "s.json"));
  }]
])("%s", (_name, make) => {
  it("gets, sets, lists and deletes", async () => {
    const store = await make();
    expect(await store.get("a")).toBeNull();
    await store.set("b", "2");
    await store.set("a", "1");
    expect(await store.get("a")).toBe("1");
    expect(await store.listKeys()).toEqual(["a", "b"]);
    await store.delete("a");
    expect(await store.listKeys()).toEqual(["b"]);
  });

  it("does not lose concurrent writes", async () => {
    const store = await make();
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.set(`k${i}`, String(i))));
    expect(await store.listKeys()).toHaveLength(25);
  });
});

describe("file backend + seed", () => {
  it("persists to one JSON file per store and loads the synthetic seed", async () => {
    dir = await mkdtemp(join(tmpdir(), "hub-seed-"));
    const stores = createStores({ STORE_BACKEND: "file", LOCAL_STORE_DIR: dir });
    const counts = await seedStores(stores);
    expect(counts).toEqual({ namespaces: 4, webhooks: 4 });

    const onDisk = JSON.parse(await readFile(join(dir, "key-value-pairs.json"), "utf8"));
    expect(Object.keys(onDisk)).toContain("pairs_support-bot");

    const fresh = createStores({ STORE_BACKEND: "file", LOCAL_STORE_DIR: dir });
    expect((await readPairs(fresh.values, "support-bot"))?.max_reply_chars).toBe("600");
    expect((await listWebhooks(fresh.webhooks)).map((w) => w.parentId)).toEqual([
      "support-bot", "booking-bot", "broken-bot", "paused-bot"
    ]);
  });
});
