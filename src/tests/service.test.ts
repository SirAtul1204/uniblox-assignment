import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { assertReady, initializePolicy, openDatabase } from "../db";
import { seed } from "../db/seed";
import {
  cartItems,
  checkouts,
  coupons,
  orderItems,
  orders,
  policy,
  products,
} from "../db/schema";
import { StoreService } from "../services/store";
import { fixture, limitedId, populatedCart, productId } from "./helpers";

test("HTTP validates customers, carts, products, quantities, JSON and keys", async (t) => {
  const f = fixture(t);
  await f.api.post("/api/customers").send({ name: " " }).expect(400);
  await f.api.post("/api/carts").send({ customerId: randomUUID() }).expect(404);
  const { cartId } = populatedCart(f.service);
  for (const quantity of [0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
    await f.api
      .put(`/api/carts/${cartId}/items/${productId}`)
      .send({ quantity })
      .expect(400);
  }
  await f.api
    .put(`/api/carts/${cartId}/items/${randomUUID()}`)
    .send({ quantity: 1 })
    .expect(404);
  await f.api
    .put(`/api/carts/${cartId}/items/${limitedId}`)
    .send({ quantity: 3 })
    .expect(409);
  await f.api.get("/api/carts/not-a-uuid").expect(400);
  await f.api
    .post("/api/customers")
    .set("Content-Type", "application/json")
    .send("{")
    .expect(400);
  await f.api
    .post("/api/customers")
    .send({ name: "A", extra: true })
    .expect(400);
  await f.api.post(`/api/carts/${cartId}/checkout`).send({}).expect(400);
  await f.api
    .post(`/api/carts/${cartId}/checkout`)
    .set("Idempotency-Key", "k")
    .send({ couponCode: "bad-code" })
    .expect(422);
  assert.equal(f.db.select().from(orders).all().length, 0);
});

test("cart PUT uses absolute quantities; DELETE is repeatable; empty carts cannot checkout", async (t) => {
  const f = fixture(t);
  const { cartId } = populatedCart(f.service);
  const route = `/api/carts/${cartId}/items/${productId}`;
  await f.api.put(route).send({ quantity: 2 }).expect(200);
  const repeated = await f.api.put(route).send({ quantity: 2 }).expect(200);
  assert.equal(repeated.body.items[0].quantity, 2);
  assert.equal(repeated.body.subtotal, "400.68");
  await f.api.delete(route).expect(200);
  await f.api.delete(route).expect(200);
  const empty = await f.api
    .post(`/api/carts/${cartId}/checkout`)
    .set("Idempotency-Key", "empty")
    .send({})
    .expect(409);
  assert.equal(empty.body.error.code, "EMPTY_CART");
  assert.equal(f.db.select().from(cartItems).all().length, 0);
});

test("checkout uses live prices while previous orders remain immutable", (t) => {
  const f = fixture(t);
  const first = populatedCart(f.service);
  f.db
    .update(products)
    .set({ name: "Updated Notebook", priceMinor: 12345 })
    .where(eq(products.id, productId))
    .run();
  assert.equal(f.service.getCart(first.cartId).total, "123.45");
  const { order } = f.service.checkout(first.cartId, "price").response;
  assert.equal(order.total, "123.45");
  assert.equal(order.items[0]!.name, "Updated Notebook");
  f.db
    .update(products)
    .set({ name: "Later Name", priceMinor: 99999 })
    .where(eq(products.id, productId))
    .run();
  assert.deepEqual(f.service.getOrder(order.id), order);
  assert.throws(
    () => f.service.setItem(first.cartId, productId, 1),
    /already been checked out/,
  );
  assert.throws(
    () => f.service.removeItem(first.cartId, productId),
    /already been checked out/,
  );
});

test("idempotency replays the original response, rejects conflicts, and survives restart", async (t) => {
  const f = fixture(t, { file: true, policy: { everyN: 1, percent: 10 } });
  const owner = f.service.createCustomer("A").id;
  const first = populatedCart(f.service, owner);
  const route = `/api/carts/${first.cartId}/checkout`;
  const initial = await f.api
    .post(route)
    .set("Idempotency-Key", "same-key")
    .send({})
    .expect(201);
  const replay = await f.api
    .post(route)
    .set("Idempotency-Key", "same-key")
    .send({})
    .expect(201);
  assert.deepEqual(replay.body, initial.body);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  const conflict = await f.api
    .post(route)
    .set("Idempotency-Key", "same-key")
    .send({ couponCode: "changed" })
    .expect(409);
  assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");
  await f.api
    .post(route)
    .set("Idempotency-Key", "other-key")
    .send({})
    .expect(409);
  const second = populatedCart(f.service, owner);
  assert.throws(
    () => f.service.checkout(second.cartId, "same-key"),
    /different checkout/,
  );
  f.service.checkout(second.cartId, "second", initial.body.earnedCoupon.code);
  assert.deepEqual(
    f.service.checkout(first.cartId, "same-key").response,
    initial.body,
  );
  assert.equal(f.db.select().from(orders).all().length, 2);
  f.sqlite.close();
  const reopened = openDatabase(f.path);
  try {
    assertReady(reopened.db, { everyN: 1, percent: 10 });
    assert.deepEqual(
      new StoreService(reopened.db).checkout(first.cartId, "same-key").response,
      initial.body,
    );
  } finally {
    reopened.sqlite.close();
  }
});

test("failed checkout leaves the key reusable after inventory is corrected", (t) => {
  const f = fixture(t);
  const { cartId } = populatedCart(f.service, undefined, limitedId, 2);
  f.db
    .update(products)
    .set({ inventory: 1 })
    .where(eq(products.id, limitedId))
    .run();
  assert.equal(f.service.getCart(cartId).items[0]!.available, false);
  assert.throws(() => f.service.checkout(cartId, "retry"), /unavailable/);
  assert.equal(f.db.select().from(checkouts).all().length, 0);
  assert.equal(f.service.getCart(cartId).status, "open");
  f.service.setItem(cartId, limitedId, 1);
  assert.equal(
    f.service.checkout(cartId, "retry").response.order.total,
    "999.95",
  );
});

test("the same idempotency key can be used independently by different customers", (t) => {
  const f = fixture(t);
  const first = populatedCart(f.service);
  const second = populatedCart(f.service);
  const a = f.service.checkout(first.cartId, "shared-client-key");
  const b = f.service.checkout(second.cartId, "shared-client-key");
  assert.notEqual(a.response.order.id, b.response.order.id);
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, false);
  assert.equal(f.service.report().totalOrders, 2);
});

test("report revenue stays exact when combined totals exceed the safe number range", (t) => {
  const f = fixture(t);
  f.db
    .update(products)
    .set({ priceMinor: Number.MAX_SAFE_INTEGER })
    .where(eq(products.id, productId))
    .run();
  const first = populatedCart(f.service);
  const second = populatedCart(f.service);
  f.service.checkout(first.cartId, "large-first");
  f.service.checkout(second.cartId, "large-second");
  const report = f.service.report();
  assert.equal(report.grossRevenue, "180143985094819.82");
  assert.equal(report.netRevenue, "180143985094819.82");
  assert.equal(report.totalDiscounts, "0.00");
});

test("store-wide milestones reward the milestone customer; coupons are owned and single-use", (t) => {
  const f = fixture(t, { policy: { everyN: 2, percent: 10 } });
  const a = populatedCart(f.service);
  const first = f.service.checkout(a.cartId, "a").response;
  assert.equal(first.earnedCoupon, null);
  const b = populatedCart(f.service);
  const second = f.service.checkout(b.cartId, "b").response;
  assert.equal(second.earnedCoupon!.customerId, b.customerId);
  assert.equal(second.earnedCoupon!.milestoneOrderId, second.order.id);
  const wrongOwner = populatedCart(f.service, a.customerId);
  assert.throws(
    () =>
      f.service.checkout(wrongOwner.cartId, "wrong", second.earnedCoupon!.code),
    /another customer/,
  );
  const rightOwner = populatedCart(f.service, b.customerId);
  const discounted = f.service.checkout(
    rightOwner.cartId,
    "right",
    second.earnedCoupon!.code,
  ).response;
  assert.equal(discounted.order.discount, "20.03");
  assert.equal(discounted.order.total, "180.31");
  const another = populatedCart(f.service, b.customerId);
  assert.throws(
    () => f.service.checkout(another.cartId, "used", second.earnedCoupon!.code),
    /already been redeemed/,
  );
  assert.equal(f.service.customerCoupons(b.customerId)[0]!.status, "redeemed");
  const fourth = f.service.checkout(another.cartId, "fourth").response;
  assert.ok(fourth.earnedCoupon);
  assert.equal(f.service.report().totalOrders, 4);
});

test("checkout supports a 100-percent coupon without a negative total", (t) => {
  const f = fixture(t, { policy: { everyN: 1, percent: 100 } });
  const first = populatedCart(f.service);
  const reward = f.service.checkout(first.cartId, "first").response
    .earnedCoupon!;
  const second = populatedCart(f.service, first.customerId);
  const order = f.service.checkout(second.cartId, "free", reward.code).response
    .order;
  assert.equal(order.subtotal, "200.34");
  assert.equal(order.discount, "200.34");
  assert.equal(order.total, "0.00");
});

test("exception after inventory and coupon mutations rolls everything back", (t) => {
  const f = fixture(t, { policy: { everyN: 1, percent: 10 } });
  const first = populatedCart(f.service);
  const reward = f.service.checkout(first.cartId, "first").response
    .earnedCoupon!;
  const second = populatedCart(f.service, first.customerId);
  const before = f.service.report();
  const inventory = f.db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .get()!.inventory;
  const faulty = new StoreService(f.db, {
    afterCheckoutMutations: () => {
      throw new Error("injected failure");
    },
  });
  assert.throws(
    () => faulty.checkout(second.cartId, "rollback", reward.code),
    /injected failure/,
  );
  assert.deepEqual(f.service.report(), before);
  assert.equal(
    f.db.select().from(products).where(eq(products.id, productId)).get()!
      .inventory,
    inventory,
  );
  assert.equal(f.service.getCart(second.cartId).status, "open");
  assert.equal(f.db.select().from(policy).get()!.orderCount, 1);
  assert.equal(f.db.select().from(checkouts).all().length, 1);
  assert.equal(f.db.select().from(orderItems).all().length, 1);
  assert.equal(
    f.service.checkout(second.cartId, "rollback", reward.code).response.order
      .discount,
    "20.03",
  );
});

test("admin only repairs reached, unrewarded milestones and refuses duplicates", async (t) => {
  const f = fixture(t, { policy: { everyN: 2, percent: 10 } });
  await f.api.post("/api/admin/coupons").send({}).expect(409);
  const first = populatedCart(f.service);
  f.service.checkout(first.cartId, "first");
  await f.api.post("/api/admin/coupons").send({}).expect(409);
  const second = populatedCart(f.service);
  const result = f.service.checkout(second.cartId, "second").response;
  await f.api.post("/api/admin/coupons").send({}).expect(409);
  // Simulate an imported legacy order missing automatic issuance; no public API deletes coupons.
  f.db.delete(coupons).where(eq(coupons.id, result.earnedCoupon!.id)).run();
  const repair = await f.api.post("/api/admin/coupons").send({}).expect(201);
  assert.equal(repair.body.customerId, second.customerId);
  assert.equal(repair.body.milestoneOrderId, result.order.id);
  await f.api.post("/api/admin/coupons").send({}).expect(409);
});

test("reports reconcile with orders, remain read-only, and include zero purchases", async (t) => {
  const f = fixture(t, { policy: { everyN: 1, percent: 10 } });
  const first = populatedCart(f.service);
  const reward = f.service.checkout(first.cartId, "first").response
    .earnedCoupon!;
  const second = populatedCart(f.service, first.customerId);
  f.service.checkout(second.cartId, "second", reward.code);
  const before = f.sqlite.prepare("SELECT total_changes() AS count").get();
  const report = await f.api.get("/api/admin/report").expect(200);
  const again = await f.api.get("/api/admin/report").expect(200);
  assert.deepEqual(again.body, report.body);
  assert.deepEqual(
    f.sqlite.prepare("SELECT total_changes() AS count").get(),
    before,
  );
  assert.equal(report.body.grossRevenue, "400.68");
  assert.equal(report.body.totalDiscounts, "20.03");
  assert.equal(report.body.netRevenue, "380.65");
  assert.equal(report.body.totalOrders, 2);
  assert.equal(report.body.purchasedQuantityByProduct[0].quantity, 2);
  assert.equal(report.body.purchasedQuantityByProduct[4].quantity, 0);
  assert.equal(report.body.coupons.generated, 2);
  assert.equal(report.body.coupons.available, 1);
  assert.equal(report.body.coupons.redeemed, 1);
});

test("seed is repeatable and policy changes or missing setup fail clearly", (t) => {
  const f = fixture(t);
  f.db
    .update(products)
    .set({ inventory: 7, priceMinor: 123 })
    .where(eq(products.id, productId))
    .run();
  seed(f.db);
  assert.equal(f.db.select().from(products).all().length, 5);
  assert.equal(
    f.db.select().from(products).where(eq(products.id, productId)).get()!
      .inventory,
    7,
  );
  assert.equal(
    f.db.select().from(products).where(eq(products.id, productId)).get()!
      .priceMinor,
    123,
  );
  assert.throws(
    () => initializePolicy(f.db, { everyN: 3, percent: 10 }),
    /differs/,
  );
  assert.throws(
    () => assertReady(f.db, { everyN: 5, percent: 20 }),
    /not ready/,
  );
  const empty = openDatabase(":memory:");
  try {
    assert.throws(
      () => assertReady(empty.db, { everyN: 5, percent: 10 }),
      /db:setup/,
    );
  } finally {
    empty.sqlite.close();
  }
});

test("numeric overflow cannot partially change a cart or create an order", (t) => {
  const f = fixture(t);
  const { cartId } = populatedCart(f.service);
  f.db
    .update(products)
    .set({
      inventory: Number.MAX_SAFE_INTEGER,
      priceMinor: Number.MAX_SAFE_INTEGER,
    })
    .where(eq(products.id, productId))
    .run();
  assert.throws(
    () => f.service.setItem(cartId, productId, 2),
    /supported integer range/,
  );
  assert.equal(f.db.select().from(cartItems).get()!.quantity, 1);
  f.db
    .insert(cartItems)
    .values({ cartId, productId: limitedId, quantity: 1 })
    .run();
  assert.throws(
    () => f.service.checkout(cartId, "overflow"),
    /supported integer range/,
  );
  assert.equal(f.db.select().from(orders).all().length, 0);
});

test("database lock timeout maps to retryable 503 and does not mutate state", async (t) => {
  const f = fixture(t, { file: true, timeout: 25 });
  const { cartId } = populatedCart(f.service);
  const lock = openDatabase(f.path);
  lock.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = await f.api
      .post(`/api/carts/${cartId}/checkout`)
      .set("Idempotency-Key", "busy")
      .send({})
      .expect(503);
    assert.equal(result.body.error.code, "DATABASE_BUSY");
    assert.equal(result.headers["retry-after"], "1");
  } finally {
    lock.sqlite.exec("ROLLBACK");
    lock.sqlite.close();
  }
  assert.equal(f.db.select().from(orders).all().length, 0);
  await f.api
    .post(`/api/carts/${cartId}/checkout`)
    .set("Idempotency-Key", "busy")
    .send({})
    .expect(201);
});
