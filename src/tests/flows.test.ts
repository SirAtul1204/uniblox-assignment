import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import request from "supertest";
import { createApp } from "../app";
import { openDatabase } from "../db";
import { coupons } from "../db/schema";
import { fixture, populatedCart } from "./helpers";

test("HTTP customer-to-report flow handles multiple products, owned rewards, discounted milestones and reopening", async (t) => {
  const f = fixture(t, { file: true, policy: { everyN: 2, percent: 10 } });
  const customerA = (
    await f.api.post("/api/customers").send({ name: "A" }).expect(201)
  ).body;
  const customerB = (
    await f.api.post("/api/customers").send({ name: "B" }).expect(201)
  ).body;
  const ids: string[] = [];
  for (const name of ["Tiny first", "Tiny second"]) {
    const product = await f.api
      .post("/api/admin/products")
      .send({ name, unitPrice: "0.05", inventory: 10 })
      .expect(201);
    ids.push(product.body.id);
  }
  async function cart(customerId: string) {
    const created = await f.api
      .post("/api/carts")
      .send({ customerId })
      .expect(201);
    for (const id of ids)
      await f.api
        .put(`/api/carts/${created.body.id}/items/${id}`)
        .send({ quantity: 1 })
        .expect(200);
    const view = await f.api.get(`/api/carts/${created.body.id}`).expect(200);
    assert.equal(view.body.subtotal, "0.10");
    assert.equal(view.body.items.length, 2);
    return created.body.id as string;
  }
  async function checkout(cartId: string, key: string, couponCode?: string) {
    return f.api
      .post(`/api/carts/${cartId}/checkout`)
      .set("Idempotency-Key", key)
      .send(couponCode ? { couponCode } : {})
      .expect(201);
  }
  const firstCart = await cart(customerA.id);
  const first = await checkout(firstCart, "one");
  assert.equal(first.body.earnedCoupon, null);
  const second = await checkout(await cart(customerB.id), "two");
  const reward = second.body.earnedCoupon;
  assert.equal(reward.customerId, customerB.id);
  assert.equal(reward.milestoneOrderId, second.body.order.id);
  assert.equal(second.body.order.discount, "0.00");

  const thirdCart = await cart(customerA.id);
  const beforeFailure = (await f.api.get("/api/admin/report").expect(200)).body;
  const wrongOwner = await f.api
    .post(`/api/carts/${thirdCart}/checkout`)
    .set("Idempotency-Key", "three")
    .send({ couponCode: reward.code })
    .expect(422);
  assert.equal(wrongOwner.body.error.code, "COUPON_CUSTOMER_MISMATCH");
  assert.deepEqual(
    (await f.api.get("/api/admin/report").expect(200)).body,
    beforeFailure,
  );
  await checkout(thirdCart, "three");

  const fourthCart = await cart(customerB.id);
  const fourth = await checkout(fourthCart, "four", reward.code);
  // Rounding per line would grant zero; subtotal rounding grants one paise.
  assert.equal(fourth.body.order.discount, "0.01");
  assert.equal(fourth.body.order.total, "0.09");
  assert.equal(fourth.body.order.appliedCoupon.code, reward.code);
  assert.equal(fourth.body.earnedCoupon.milestoneOrderId, fourth.body.order.id);
  const replay = await checkout(fourthCart, "four", reward.code);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.deepEqual(replay.body, fourth.body);
  for (const response of [first, second, fourth]) {
    assert.deepEqual(
      (await f.api.get(`/api/orders/${response.body.order.id}`).expect(200))
        .body,
      response.body.order,
    );
  }
  for (const method of ["put", "delete"] as const) {
    const response = await f.api[method](
      `/api/carts/${fourthCart}/items/${ids[0]}`,
    )
      .send(method === "put" ? { quantity: 1 } : {})
      .expect(409);
    assert.equal(response.body.error.code, "CART_ALREADY_CHECKED_OUT");
  }
  const unusedCart = await cart(customerB.id);
  const reused = await f.api
    .post(`/api/carts/${unusedCart}/checkout`)
    .set("Idempotency-Key", "used")
    .send({ couponCode: reward.code })
    .expect(422);
  assert.equal(reused.body.error.code, "COUPON_ALREADY_REDEEMED");
  const owned = (
    await f.api.get(`/api/customers/${customerB.id}/coupons`).expect(200)
  ).body;
  assert.equal(
    owned.find((c: { code: string }) => c.code === reward.code).redeemedOrderId,
    fourth.body.order.id,
  );
  assert.deepEqual(
    (await f.api.get(`/api/customers/${customerA.id}/coupons`).expect(200))
      .body,
    [],
  );
  const recovery = await f.api.post("/api/admin/coupons").send({}).expect(409);
  assert.equal(recovery.body.error.code, "NO_ELIGIBLE_MILESTONE");
  const report = (await f.api.get("/api/admin/report").expect(200)).body;
  assert.equal(report.totalOrders, 4);
  assert.equal(report.grossRevenue, "0.40");
  assert.equal(report.totalDiscounts, "0.01");
  assert.equal(report.netRevenue, "0.39");
  assert.equal(report.coupons.generated, 2);
  assert.equal(report.coupons.available, 1);
  assert.equal(report.coupons.redeemed, 1);
  const catalog = (await f.api.get("/api/products").expect(200)).body;
  for (const id of ids) {
    assert.equal(
      report.purchasedQuantityByProduct.find(
        (p: { productId: string }) => p.productId === id,
      ).quantity,
      4,
    );
    assert.equal(catalog.find((p: { id: string }) => p.id === id).inventory, 6);
  }
  assert.deepEqual(
    (await f.api.get("/api/admin/report").expect(200)).body,
    report,
  );
  f.sqlite.close();
  const reopened = openDatabase(f.path);
  try {
    const api = request(createApp(reopened, { rewardPolicy: f.rewardPolicy }));
    assert.deepEqual(
      (await api.get("/api/admin/report").expect(200)).body,
      report,
    );
    assert.deepEqual(
      (await api.get("/api/products").expect(200)).body,
      catalog,
    );
    assert.deepEqual(
      (await api.get(`/api/customers/${customerB.id}/coupons`).expect(200))
        .body,
      owned,
    );
    const persisted = await api
      .post(`/api/carts/${fourthCart}/checkout`)
      .set("Idempotency-Key", "four")
      .send({ couponCode: reward.code })
      .expect(201);
    assert.deepEqual(persisted.body, fourth.body);
    assert.equal(persisted.headers["idempotency-replayed"], "true");
  } finally {
    reopened.sqlite.close();
  }
});

test("admin recovery repairs multiple missing milestones in oldest-first order without changing replay", async (t) => {
  const f = fixture(t, { policy: { everyN: 1, percent: 10 } });
  const purchases = ["oldest", "newest"].map((key) => {
    const cart = populatedCart(f.service);
    return {
      ...cart,
      key,
      response: f.service.checkout(cart.cartId, key).response,
    };
  });
  for (const purchase of purchases)
    f.db
      .delete(coupons)
      .where(eq(coupons.id, purchase.response.earnedCoupon!.id))
      .run();
  for (const purchase of purchases) {
    const repair = await f.api.post("/api/admin/coupons").send({}).expect(201);
    assert.equal(repair.body.milestoneOrderId, purchase.response.order.id);
    assert.equal(repair.body.customerId, purchase.customerId);
    assert.deepEqual(
      f.service.checkout(purchase.cartId, purchase.key).response,
      purchase.response,
    );
  }
  await f.api.post("/api/admin/coupons").send({}).expect(409);
  assert.equal(f.service.report().coupons.generated, 2);
});

test("HTTP errors distinguish missing resources, malformed requests, oversized bodies and unknown routes", async (t) => {
  const f = fixture(t);
  const missing = randomUUID();
  for (const [path, code] of [
    [`/api/carts/${missing}`, "CART_NOT_FOUND"],
    [`/api/orders/${missing}`, "ORDER_NOT_FOUND"],
    [`/api/customers/${missing}/coupons`, "CUSTOMER_NOT_FOUND"],
    ["/api/unknown", "ROUTE_NOT_FOUND"],
  ]) {
    const response = await f.api.get(path!).expect(404);
    assert.equal(response.body.error.code, code);
    assert.equal(typeof response.body.error.message, "string");
  }
  const { cartId } = populatedCart(f.service);
  for (const key of ["has spaces", "x".repeat(129)]) {
    const response = await f.api
      .post(`/api/carts/${cartId}/checkout`)
      .set("Idempotency-Key", key)
      .send({})
      .expect(400);
    assert.equal(response.body.error.code, "VALIDATION_ERROR");
  }
  for (const body of [
    { couponCode: "" },
    { couponCode: null },
    { couponCode: ["one", "two"] },
    { extra: true },
  ]) {
    await f.api
      .post(`/api/carts/${cartId}/checkout`)
      .set("Idempotency-Key", "validation")
      .send(body)
      .expect(400);
  }
  const oversized = await f.api
    .post("/api/customers")
    .send({ name: "x".repeat(17000) })
    .expect(413);
  assert.equal(oversized.body.error.code, "BODY_TOO_LARGE");
  assert.equal(f.service.report().totalOrders, 0);
  assert.equal(f.service.getCart(cartId).status, "open");
});

test("HTTP unexpected checkout failure is logged, sanitized, rolled back and retryable", async (t) => {
  const f = fixture(t, { policy: { everyN: 1, percent: 10 } });
  const first = populatedCart(f.service);
  const reward = f.service.checkout(first.cartId, "first").response
    .earnedCoupon!;
  const second = populatedCart(f.service, first.customerId);
  const before = f.service.report();
  const stock = f.service.listProducts();
  const internal = new Error("private database failure details");
  const logged: unknown[] = [];
  const faulty = request(
    createApp(f, {
      rewardPolicy: f.rewardPolicy,
      hooks: {
        afterCheckoutMutations: () => {
          throw internal;
        },
      },
      log: (error) => logged.push(error),
    }),
  );
  const response = await faulty
    .post(`/api/carts/${second.cartId}/checkout`)
    .set("Idempotency-Key", "recover")
    .send({ couponCode: reward.code })
    .expect(500);
  assert.deepEqual(response.body, {
    error: { code: "INTERNAL_ERROR", message: "Internal server error" },
  });
  assert.deepEqual(logged, [internal]);
  assert.deepEqual(f.service.report(), before);
  assert.deepEqual(f.service.listProducts(), stock);
  assert.equal(f.service.getCart(second.cartId).status, "open");
  await f.api
    .post(`/api/carts/${second.cartId}/checkout`)
    .set("Idempotency-Key", "recover")
    .send({ couponCode: reward.code })
    .expect(201);
});

test("startup rejects invalid environment reward policies and accepts boundary values", () => {
  for (const [everyN, percent, valid] of [
    ["0", "10", false],
    ["-1", "10", false],
    ["1.5", "10", false],
    ["9007199254740992", "10", false],
    ["five", "10", false],
    ["5", "0", false],
    ["5", "101", false],
    ["5", "10.5", false],
    ["1", "1", true],
    ["9007199254740991", "100", true],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/config/env.ts"],
      {
        env: {
          ...process.env,
          PORT: "3000",
          REWARD_EVERY_N_ORDERS: everyN,
          REWARD_DISCOUNT_PERCENT: percent,
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.ifError(result.error);
    if (valid) assert.equal(result.status, 0, result.stderr);
    else {
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /REWARD_EVERY_N_ORDERS must be a positive safe integer/,
      );
    }
  }
});
