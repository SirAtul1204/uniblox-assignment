import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

async function run(args: string[], env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${args.join(" ")} exited ${code}`)),
    );
  });
}
async function main() {
  const dir = mkdtempSync(join(tmpdir(), "checkout-compiled-"));
  let server: ChildProcess | undefined;
  try {
    const probe = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        assert.ok(address && typeof address !== "string");
        probe.close(() => resolve(address.port));
      });
    });
    const env = {
      ...process.env,
      DATABASE_PATH: join(dir, "smoke.sqlite"),
      PORT: String(port),
      REWARD_EVERY_N_ORDERS: "1",
      REWARD_DISCOUNT_PERCENT: "10",
      API_BASE_URL: `http://127.0.0.1:${port}/api`,
    };
    await run(["dist/db/manage.js", "setup"], env);
    // Prove setup is repeatable against the same persisted database.
    await run(["dist/db/manage.js", "setup"], env);
    server = spawn(process.execPath, ["dist/server.js"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    server.stdout?.on("data", (data) => {
      output += String(data);
    });
    server.stderr?.on("data", (data) => {
      output += String(data);
    });
    server.on("error", (error) => {
      output += String(error);
    });
    let ready = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const response = await fetch(`${env.API_BASE_URL}/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* Wait for the compiled server to bind its port. */
      }
    }
    assert.ok(ready, `Compiled server did not start: ${output}`);
    await run(["dist/scripts/demo.js"], env);
    console.log("Compiled JavaScript smoke test passed.");
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => server?.kill("SIGKILL"), 2000);
        server!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        server!.kill("SIGTERM");
      });
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
