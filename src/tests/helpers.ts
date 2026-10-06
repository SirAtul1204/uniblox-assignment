import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import request from "supertest";
import { createApp } from "../app";
import { initializePolicy, openDatabase, type RewardPolicy } from "../db";
import { seed, seedProducts } from "../db/seed";
import { StoreService, type StoreHooks } from "../services/store";

export const productId = seedProducts[0]!.id;
export const limitedId = seedProducts[4]!.id;

export function fixture(
  t: TestContext,
  options: {
    policy?: RewardPolicy;
    file?: boolean;
    hooks?: StoreHooks;
    timeout?: number;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "checkout-test-"));
  const path = options.file ? join(dir, "test.sqlite") : ":memory:";
  const context = openDatabase(path, options.timeout);
  migrate(context.db, { migrationsFolder: resolve("migrations") });
  initializePolicy(context.db, options.policy ?? { everyN: 5, percent: 10 });
  seed(context.db);
  const service = new StoreService(context.db, options.hooks);
  const app = createApp(context, { hooks: options.hooks, log: () => {} });
  t.after(() => {
    if (context.sqlite.open) context.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...context, dir, path, service, app, api: request(app) };
}

export function populatedCart(
  service: StoreService,
  customerId?: string,
  itemId = productId,
  quantity = 1,
) {
  const owner = customerId ?? service.createCustomer("Test Customer").id;
  const cart = service.createCart(owner);
  service.setItem(cart.id, itemId, quantity);
  return { cartId: cart.id, customerId: owner };
}
