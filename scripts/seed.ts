// Reset the local file store (data/local/) to the synthetic seed in data/seed.json.
import { rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { createStores, resolveBackend } from "../src/server/store";
import { seedStores } from "./seed-lib";

const env: NodeJS.ProcessEnv = { ...process.env, STORE_BACKEND: process.env.STORE_BACKEND || "file" };
if (resolveBackend(env) !== "file") {
  console.error("npm run seed only resets the local file store. Unset STORE_BACKEND or set it to file.");
  process.exit(1);
}

const dir = env.LOCAL_STORE_DIR || join(process.cwd(), "data", "local");
await rm(dir, { recursive: true, force: true });
const counts = await seedStores(createStores(env));
console.log(`Seeded ${counts.namespaces} config namespaces and ${counts.webhooks} webhook routes into ${relative(process.cwd(), dir) || dir}`);
