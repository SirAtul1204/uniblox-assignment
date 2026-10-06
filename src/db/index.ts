import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
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

export function initializePolicy(db: Db, expected: RewardPolicy) {
  if (
    !Number.isSafeInteger(expected.everyN) ||
    expected.everyN < 1 ||
    !Number.isInteger(expected.percent) ||
    expected.percent < 1 ||
    expected.percent > 100
  )
    throw new Error(
      "Reward policy requires positive integer n and integer percent between 1 and 100",
    );
  db.transaction(
    (tx) => {
      tx.insert(schema.policy)
        .values({ id: 1, ...expected, orderCount: 0 })
        .onConflictDoNothing()
        .run();
      const stored = tx
        .select()
        .from(schema.policy)
        .where(eq(schema.policy.id, 1))
        .get()!;
      if (
        stored.everyN !== expected.everyN ||
        stored.percent !== expected.percent
      )
        throw new Error(
          "Reward policy differs from this database. Restore its original n/x configuration.",
        );
    },
    { behavior: "immediate" },
  );
}
export function assertReady(db: Db, expected: RewardPolicy) {
  try {
    const stored = db.select().from(schema.policy).get();
    if (!stored) throw new Error("Missing reward policy");
    if (
      stored.everyN !== expected.everyN ||
      stored.percent !== expected.percent
    )
      throw new Error("Reward policy differs from configured n/x");
    db.select().from(schema.checkouts).limit(1).all();
  } catch (error) {
    throw new Error(
      `Database is not ready. Run npm run db:setup with the original reward configuration. ${error instanceof Error ? error.message : ""}`,
    );
  }
}
