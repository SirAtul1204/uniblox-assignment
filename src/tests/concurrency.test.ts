import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { eq } from "drizzle-orm";
import type { DatabaseContext, RewardPolicy } from "../db";
import { coupons, orders, products } from "../db/schema";
import { fixture, limitedId, populatedCart, productId } from "./helpers";

interface Worker {
  child: ChildProcess;
  port: number;
}
function waitMessage(
  child: ChildProcess,
  type: string,
): Promise<{ port: number }> {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(
      () => finish(new Error(`Worker did not send ${type}`)),
      10_000,
    );
    const finish = (error?: Error, value?: { port: number }) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolveMessage(value!);
    };
    const onMessage = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === type
      ) {
        finish(undefined, {
          port:
            "port" in message && typeof message.port === "number"
              ? message.port
              : 0,
        });
      }
    };
    const onExit = (code: number | null) =>
      finish(new Error(`Worker exited early: ${code}`));
    const onError = (error: Error) => finish(error);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
async function startWorker(
  path: string,
  rewardPolicy: RewardPolicy,
): Promise<Worker> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve("src/tests/worker.ts"), path],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        REWARD_EVERY_N_ORDERS: String(rewardPolicy.everyN),
        REWARD_DISCOUNT_PERCENT: String(rewardPolicy.percent),
      },
    },
  );
  let output = "";
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  try {
    const ready = await waitMessage(child, "ready");
    return { child, port: ready.port };
  } catch (error) {
    child.kill();
    throw new Error(`${String(error)} ${output}`);
  }
}
async function stopWorker(worker: Worker) {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null)
    return;
  await new Promise<void>((resolveExit) => {
    const timeout = setTimeout(() => worker.child.kill(), 2000);
    worker.child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
    worker.child.send("shutdown");
  });
}
async function withWorkers(
  path: string,
  rewardPolicy: RewardPolicy,
  run: (workers: [Worker, Worker]) => Promise<void>,
) {
  const started = await Promise.allSettled([
    startWorker(path, rewardPolicy),
    startWorker(path, rewardPolicy),
  ]);
  const workers = started
    .filter(
      (r): r is PromiseFulfilledResult<Worker> => r.status === "fulfilled",
    )
    .map((r) => r.value);
  try {
    const failure = started.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    await run(workers as [Worker, Worker]);
  } finally {
    await Promise.all(workers.map(stopWorker));
  }
}
interface Attempt {
  route: string;
  key?: string;
  body?: unknown;
}
async function race(
  context: DatabaseContext,
  workers: [Worker, Worker],
  attempts: [Attempt, Attempt],
) {
  // Hold the writer lock until both independent processes have entered HTTP handlers.
  // Both then compete for the same database write lock when it is released.
  context.sqlite.exec("BEGIN IMMEDIATE");
  const started = workers.map((worker) =>
    waitMessage(worker.child, "request-started"),
  );
  const responses = workers.map((worker, index) => {
    const attempt = attempts[index]!;
    return fetch(`http://127.0.0.1:${worker.port}/api${attempt.route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(attempt.key ? { "Idempotency-Key": attempt.key } : {}),
      },
      body: JSON.stringify(attempt.body ?? {}),
    });
  });
  try {
    await Promise.all(started);
  } finally {
    context.sqlite.exec("ROLLBACK");
  }
  return Promise.all(
    responses.map(async (responsePromise) => {
      const response = await responsePromise;
      return {
        status: response.status,
        replayed: response.headers.get("Idempotency-Replayed"),
        body: await response.json(),
      };
    }),
  );
}

test(
  "separate processes replay competing identical checkout keys without double purchase",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t, { file: true, policy: { everyN: 1, percent: 10 } });
    const { cartId } = populatedCart(f.service);
    await withWorkers(f.path, f.rewardPolicy, async (workers) => {
      const attempt = { route: `/carts/${cartId}/checkout`, key: "same" };
      const result = await race(f, workers, [attempt, attempt]);
      assert.deepEqual(
        result.map((r) => r.status),
        [201, 201],
      );
      assert.deepEqual(result[0]!.body, result[1]!.body);
      assert.equal(result.filter((r) => r.replayed === "true").length, 1);
    });
    assert.equal(f.db.select().from(orders).all().length, 1);
    assert.equal(f.db.select().from(coupons).all().length, 1);
    assert.equal(
      f.db.select().from(products).where(eq(products.id, productId)).get()!
        .inventory,
      99,
    );
  },
);

test(
  "separate processes using different keys cannot purchase the same cart twice",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t, { file: true });
    const { cartId } = populatedCart(f.service);
    await withWorkers(f.path, f.rewardPolicy, async (workers) => {
      const result = await race(f, workers, [
        { route: `/carts/${cartId}/checkout`, key: "one" },
        { route: `/carts/${cartId}/checkout`, key: "two" },
      ]);
      assert.deepEqual(result.map((r) => r.status).sort(), [201, 409]);
      assert.equal(
        result.find((r) => r.status === 409)!.body.error.code,
        "CART_ALREADY_CHECKED_OUT",
      );
    });
    assert.equal(f.service.report().totalOrders, 1);
  },
);

test(
  "separate processes cannot oversell the last inventory unit",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t, { file: true });
    f.db
      .update(products)
      .set({ inventory: 1 })
      .where(eq(products.id, limitedId))
      .run();
    const a = populatedCart(f.service, undefined, limitedId);
    const b = populatedCart(f.service, undefined, limitedId);
    await withWorkers(f.path, f.rewardPolicy, async (workers) => {
      const result = await race(f, workers, [
        { route: `/carts/${a.cartId}/checkout`, key: "a" },
        { route: `/carts/${b.cartId}/checkout`, key: "b" },
      ]);
      assert.deepEqual(result.map((r) => r.status).sort(), [201, 409]);
      assert.equal(
        result.find((r) => r.status === 409)!.body.error.code,
        "INSUFFICIENT_INVENTORY",
      );
    });
    assert.equal(
      f.db.select().from(products).where(eq(products.id, limitedId)).get()!
        .inventory,
      0,
    );
    assert.equal(f.service.report().totalOrders, 1);
    assert.equal(
      [f.service.getCart(a.cartId), f.service.getCart(b.cartId)].filter(
        (c) => c.status === "open",
      ).length,
      1,
    );
  },
);

test(
  "separate processes cannot redeem the same customer coupon twice",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t, { file: true, policy: { everyN: 1, percent: 10 } });
    const first = populatedCart(f.service);
    const reward = f.service.checkout(first.cartId, "reward").response
      .earnedCoupon!;
    const a = populatedCart(f.service, first.customerId);
    const b = populatedCart(f.service, first.customerId);
    await withWorkers(f.path, f.rewardPolicy, async (workers) => {
      const result = await race(f, workers, [
        {
          route: `/carts/${a.cartId}/checkout`,
          key: "a",
          body: { couponCode: reward.code },
        },
        {
          route: `/carts/${b.cartId}/checkout`,
          key: "b",
          body: { couponCode: reward.code },
        },
      ]);
      assert.deepEqual(result.map((r) => r.status).sort(), [201, 422]);
      assert.equal(
        result.find((r) => r.status === 422)!.body.error.code,
        "COUPON_ALREADY_REDEEMED",
      );
    });
    const report = f.service.report();
    assert.equal(report.totalOrders, 2);
    assert.equal(report.totalDiscounts, "20.03");
    assert.equal(report.coupons.redeemed, 1);
    assert.equal(
      f.db.select().from(products).where(eq(products.id, productId)).get()!
        .inventory,
      98,
    );
  },
);

test(
  "competing admin requests generate exactly one coupon for a missing milestone",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t, { file: true, policy: { everyN: 1, percent: 10 } });
    const cart = populatedCart(f.service);
    const result = f.service.checkout(cart.cartId, "reward").response;
    f.db.delete(coupons).where(eq(coupons.id, result.earnedCoupon!.id)).run();
    await withWorkers(f.path, f.rewardPolicy, async (workers) => {
      const responses = await race(f, workers, [
        { route: "/admin/coupons" },
        { route: "/admin/coupons" },
      ]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
      assert.equal(
        responses.find((r) => r.status === 409)!.body.error.code,
        "NO_ELIGIBLE_MILESTONE",
      );
    });
    assert.equal(f.db.select().from(coupons).all().length, 1);
  },
);
