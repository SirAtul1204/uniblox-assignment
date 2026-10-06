import { createApp } from "./app";
import { env } from "./config/env";
import { assertReady, openDatabase } from "./db";

const context = openDatabase(env.databasePath);
const { sqlite } = context;
try {
  assertReady(context.db, env);
} catch (error) {
  sqlite.close();
  throw error;
}
const app = createApp(context);

const server = app.listen(env.port, () => {
  console.log(`Server listening on http://localhost:${env.port}`);
});

server.on("error", (error) => {
  console.error(error);
  sqlite.close();
  process.exitCode = 1;
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  server.close((error) => {
    clearTimeout(timeout);
    sqlite.close();
    process.exitCode = error ? 1 : 0;
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
