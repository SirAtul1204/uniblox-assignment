import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export function openDatabase(path: string, timeout = 5000) {
  if (path !== ":memory:")
    mkdirSync(dirname(resolve(path)), { recursive: true });
  const sqlite = new Database(path, { timeout });
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
export type DatabaseContext = ReturnType<typeof openDatabase>;
export type Db = DatabaseContext["db"];
export type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Transaction;
export interface RewardPolicy {
  everyN: number;
  percent: number;
}

export function assertReady(db: Db) {
  try {
    db.select().from(schema.orders).limit(1).all();
    db.select().from(schema.checkouts).limit(1).all();
  } catch (error) {
    throw new Error(
      `Database is not ready. Run npm run db:setup. ${error instanceof Error ? error.message : ""}`,
    );
  }
}
