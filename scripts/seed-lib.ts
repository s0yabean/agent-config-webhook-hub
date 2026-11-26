import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Stores } from "../src/server/store";
import { saveValues } from "../src/server/values";
import { saveWebhook } from "../src/server/webhooks";

const SEED_FILE = fileURLToPath(new URL("../data/seed.json", import.meta.url));

interface Seed {
  values: Record<string, Record<string, string>>;
  webhooks: unknown[];
}

/** Load data/seed.json (synthetic) into the given stores through the same code the API uses. */
export async function seedStores(stores: Stores): Promise<{ namespaces: number; webhooks: number }> {
  const seed = JSON.parse(await readFile(SEED_FILE, "utf8")) as Seed;
  for (const [parentId, pairs] of Object.entries(seed.values)) {
    await saveValues(stores.values, parentId, pairs, "replace");
  }
  for (const webhook of seed.webhooks) {
    await saveWebhook(stores.webhooks, webhook);
  }
  return { namespaces: Object.keys(seed.values).length, webhooks: seed.webhooks.length };
}
