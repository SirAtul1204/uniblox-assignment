import { resolve } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { env } from "../config/env";
import { assertReady, openDatabase } from "./index";
import { seed } from "./seed";

const context = openDatabase(env.databasePath);
try {
  const command = process.argv[2];
  if (command !== "seed" && command !== "migrate" && command !== "setup")
    throw new Error("Expected seed, migrate, or setup");
  if (command !== "seed") {
    migrate(context.db, { migrationsFolder: resolve("migrations") });
  }
  assertReady(context.db);
  if (command !== "migrate") seed(context.db);
  console.log(`Database ${command} complete`);
} finally {
  context.sqlite.close();
}
