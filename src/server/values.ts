import { HttpError } from "./http";
import { readJson, writeJson, type BlobStore } from "./store";
import type { Pairs } from "./types";

export const DEFAULT_PARENT_ID = "default";
const PARENT_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

/** A parentId is a namespace: one agent, one workflow or one contact directory. */
export function normaliseParentId(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_PARENT_ID;
  if (typeof raw !== "string" || !PARENT_ID_RE.test(raw)) {
    throw new HttpError(400, "parentId must be 1-100 characters of letters, digits, _ . : or -");
  }
  return raw;
}

export function blobKeyFor(parentId: string): string {
  return `pairs_${parentId}`;
}

/** Values are strings only, so agents never have to guess a type. */
export function validatePairs(raw: unknown): Pairs {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, "pairs must be an object of string keys to string values");
  }
  const out: Pairs = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.trim()) throw new HttpError(400, "Keys must not be empty");
    if (typeof value !== "string") {
      throw new HttpError(400, `Value for key "${key}" must be a string, received ${typeof value}`);
    }
    out[key] = value;
  }
  return out;
}

export interface MergeResult {
  pairs: Pairs;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
}

/**
 * "merge" keeps existing keys and overwrites the ones sent (the original
 * behaviour). "replace" makes the namespace exactly equal to what was sent.
 */
export function mergePairs(existing: Pairs, incoming: Pairs, mode: "merge" | "replace"): MergeResult {
  const pairs: Pairs = mode === "replace" ? {} : { ...existing };
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in existing)) added++;
    else if (existing[key] !== value) updated++;
    else unchanged++;
    pairs[key] = value;
  }
  const removed = mode === "replace" ? Object.keys(existing).filter((k) => !(k in incoming)).length : 0;
  return { pairs, added, updated, unchanged, removed };
}

/** Case-insensitive substring match on values; any term may match. No terms returns everything. */
export function filterPairs(pairs: Pairs, terms: string[]): Pairs {
  const needles = terms.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (needles.length === 0) return { ...pairs };
  return Object.fromEntries(
    Object.entries(pairs).filter(([, value]) => {
      const hay = value.toLowerCase();
      return needles.some((n) => hay.includes(n));
    })
  );
}

export function parseSearchTerms(raw: string | undefined): string[] {
  return (raw || "").split(",").map((t) => t.trim()).filter(Boolean);
}

export async function readPairs(store: BlobStore, parentId: string): Promise<Pairs | null> {
  const pairs = await readJson<Pairs | null>(store, blobKeyFor(parentId), null);
  return pairs && typeof pairs === "object" && !Array.isArray(pairs) ? pairs : null;
}

export async function saveValues(
  store: BlobStore,
  parentId: string,
  incoming: Pairs,
  mode: "merge" | "replace" = "merge"
): Promise<Omit<MergeResult, "pairs">> {
  const existing = (await readPairs(store, parentId)) ?? {};
  const { pairs, ...counts } = mergePairs(existing, incoming, mode);
  await writeJson(store, blobKeyFor(parentId), pairs);
  return counts;
}

export async function getValue(store: BlobStore, parentId: string, key: string): Promise<string> {
  const pairs = await readPairs(store, parentId);
  if (!pairs) throw new HttpError(404, `No values stored for parentId: ${parentId}`);
  if (!(key in pairs)) throw new HttpError(404, `Key '${key}' not found for parentId: ${parentId}`);
  return pairs[key];
}

export async function deleteKeys(store: BlobStore, parentId: string, keys: string[]): Promise<number> {
  const pairs = await readPairs(store, parentId);
  if (!pairs) return 0;
  let removed = 0;
  for (const key of keys) {
    if (key in pairs) {
      delete pairs[key];
      removed++;
    }
  }
  if (removed > 0) await writeJson(store, blobKeyFor(parentId), pairs);
  return removed;
}

export async function deleteNamespace(store: BlobStore, parentId: string): Promise<void> {
  await store.delete(blobKeyFor(parentId));
}

export async function listParentIds(store: BlobStore): Promise<string[]> {
  const ids = (await store.listKeys())
    .map((key) => /^pairs_(.+)$/.exec(key)?.[1])
    .filter((id): id is string => Boolean(id));
  const rest = ids.filter((id) => id !== DEFAULT_PARENT_ID);
  return [DEFAULT_PARENT_ID, ...rest];
}
