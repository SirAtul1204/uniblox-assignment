import { defineConfig } from "drizzle-kit";
import { env } from "../config/env";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dbCredentials: { url: env.databasePath },
});
