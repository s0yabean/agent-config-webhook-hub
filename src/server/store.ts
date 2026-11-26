import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getStore } from "@netlify/blobs";

/**
 * The subset of the Netlify Blobs store API this app uses. Every backend
 * (memory, file, Netlify) implements it, so the handlers never know which
 * one they are talking to.
 */
export interface BlobStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(): Promise<string[]>;
}

/** The two logical stores the original app used. */
export interface Stores {
  values: BlobStore;
  webhooks: BlobStore;
}

export const STORE_NAMES = {
  values: "key-value-pairs",
  webhooks: "webhook-mappings"
} as const;

export type StoreBackend = "memory" | "file" | "netlify";

export class MemoryStore implements BlobStore {
  private data = new Map<string, string>();

  async get(key: string) {
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async listKeys() {
    return [...this.data.keys()].sort();
  }
}

/**
 * One JSON file per store: { "<blob key>": "<blob string>" }. Writes are
 * serialised through a promise chain and land via an atomic rename, which is
 * enough for a single local process. Not for production.
 */
export class FileStore implements BlobStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async readAll(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeAll(data: Record<string, string>) {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    await rename(tmp, this.file);
  }

  private update(fn: (data: Record<string, string>) => void) {
    const next = this.chain.then(async () => {
      const data = await this.readAll();
      fn(data);
      await this.writeAll(data);
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  async get(key: string) {
    await this.chain;
    const data = await this.readAll();
    return key in data ? data[key] : null;
  }
  async set(key: string, value: string) {
    await this.update((data) => {
      data[key] = value;
    });
  }
  async delete(key: string) {
    await this.update((data) => {
      delete data[key];
    });
  }
  async listKeys() {
    await this.chain;
    return Object.keys(await this.readAll()).sort();
  }
}

/** Adapter over a real Netlify Blobs store. */
export class NetlifyBlobStore implements BlobStore {
  private readonly store: ReturnType<typeof getStore>;

  constructor(name: string, siteID?: string, token?: string) {
    this.store = siteID && token ? getStore({ name, siteID, token }) : getStore(name);
  }

  async get(key: string): Promise<string | null> {
    return (await this.store.get(key, { type: "text" })) ?? null;
  }
  async set(key: string, value: string) {
    await this.store.set(key, value);
  }
  async delete(key: string) {
    await this.store.delete(key);
  }
  async listKeys() {
    const { blobs } = await this.store.list();
    return blobs.map((b) => b.key).sort();
  }
}

export function resolveBackend(env: NodeJS.ProcessEnv): StoreBackend {
  const raw = (env.STORE_BACKEND || "").trim().toLowerCase();
  if (raw === "memory" || raw === "file" || raw === "netlify") return raw;
  if (raw) throw new Error(`Unknown STORE_BACKEND "${raw}". Use memory, file or netlify.`);
  // On Netlify the platform sets NETLIFY=true; everywhere else default to the file store.
  return env.NETLIFY === "true" ? "netlify" : "file";
}

export function createStores(env: NodeJS.ProcessEnv): Stores {
  const backend = resolveBackend(env);
  if (backend === "memory") {
    return { values: new MemoryStore(), webhooks: new MemoryStore() };
  }
  if (backend === "file") {
    const dir = env.LOCAL_STORE_DIR || join(process.cwd(), "data", "local");
    return {
      values: new FileStore(join(dir, `${STORE_NAMES.values}.json`)),
      webhooks: new FileStore(join(dir, `${STORE_NAMES.webhooks}.json`))
    };
  }
  const siteID = env.SITE_ID || env.NETLIFY_SITE_ID;
  const token = env.NETLIFY_AUTH_TOKEN;
  return {
    values: new NetlifyBlobStore(STORE_NAMES.values, siteID, token),
    webhooks: new NetlifyBlobStore(STORE_NAMES.webhooks, siteID, token)
  };
}

export function memoryStores(): Stores {
  return { values: new MemoryStore(), webhooks: new MemoryStore() };
}

/** Read a JSON blob, falling back when it is missing or unparseable. */
export async function readJson<T>(store: BlobStore, key: string, fallback: T): Promise<T> {
  const raw = await store.get(key);
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(store: BlobStore, key: string, value: unknown): Promise<void> {
  await store.set(key, JSON.stringify(value));
}
