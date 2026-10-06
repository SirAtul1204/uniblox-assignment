import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fixture, populatedCart, productId } from "./helpers";

test("admin creates a product with exact INR price and can update individual fields", async (t) => {
  const f = fixture(t);
  const created = await f.api
    .post("/api/admin/products")
    .send({ name: "  Desk Lamp  ", unitPrice: "200.3", inventory: 4 })
    .expect(201);
  assert.match(created.body.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.body.name, "Desk Lamp");
  assert.equal(created.body.unitPrice, "200.30");
  assert.equal(created.body.currency, "INR");
  const route = `/api/admin/products/${created.body.id}`;
  const renamed = await f.api
    .patch(route)
    .send({ name: "Reading Lamp" })
    .expect(200);
  assert.equal(renamed.body.unitPrice, "200.30");
  assert.equal(renamed.body.inventory, 4);
  const repriced = await f.api
    .patch(route)
    .send({ unitPrice: "349.99" })
    .expect(200);
  assert.equal(repriced.body.name, "Reading Lamp");
  assert.equal(repriced.body.inventory, 4);
  const updated = await f.api.patch(route).send({ inventory: 0 }).expect(200);
  assert.equal(updated.body.unitPrice, "349.99");
  const catalog = await f.api.get("/api/products").expect(200);
  assert.equal(catalog.body.length, 6);
  assert.deepEqual(
    catalog.body.find((row: { id: string }) => row.id === created.body.id),
    updated.body,
  );
});

test("product administration rejects invalid prices, stock, fields and missing products", async (t) => {
  const f = fixture(t);
  const valid = { name: "Lamp", unitPrice: "200.34", inventory: 2 };
  for (const unitPrice of [
    200.34,
    "-1.00",
    "1.001",
    "1e2",
    "01.00",
    "90071992547409.92",
  ]) {
    await f.api
      .post("/api/admin/products")
      .send({ ...valid, unitPrice })
      .expect(400);
  }
  for (const inventory of [-1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
    await f.api
      .post("/api/admin/products")
      .send({ ...valid, inventory })
      .expect(400);
  }
  await f.api
    .post("/api/admin/products")
    .send({ ...valid, name: " " })
    .expect(400);
  await f.api
    .post("/api/admin/products")
    .send({ ...valid, currency: "USD" })
    .expect(400);
  await f.api
    .post("/api/admin/products")
    .send({ name: "Missing fields" })
    .expect(400);
  await f.api.patch(`/api/admin/products/${productId}`).send({}).expect(400);
  await f.api
    .patch(`/api/admin/products/${productId}`)
    .send({ inventory: null })
    .expect(400);
  await f.api
    .patch(`/api/admin/products/${productId}`)
    .send({ id: randomUUID() })
    .expect(400);
  await f.api
    .patch("/api/admin/products/not-an-id")
    .send({ name: "A" })
    .expect(400);
  const missing = await f.api
    .patch(`/api/admin/products/${randomUUID()}`)
    .send({ name: "A" })
    .expect(404);
  assert.equal(missing.body.error.code, "PRODUCT_NOT_FOUND");
  assert.equal(f.service.listProducts().length, 5);
  const before = f.service
    .listProducts()
    .find((product) => product.id === productId);
  await f.api
    .patch(`/api/admin/products/${productId}`)
    .send({ name: "Changed", inventory: 50, unitPrice: "bad" })
    .expect(400);
  assert.deepEqual(
    f.service.listProducts().find((product) => product.id === productId),
    before,
  );
});

test("product updates affect live carts and checkout without changing earlier orders or revenue", async (t) => {
  const f = fixture(t);
  const first = populatedCart(f.service);
  const oldOrder = f.service.checkout(first.cartId, "old-order").response.order;
  const second = populatedCart(f.service, first.customerId);
  await f.api
    .patch(`/api/admin/products/${productId}`)
    .send({ name: "Revised Notebook", unitPrice: "250.75", inventory: 0 })
    .expect(200);
  const cart = await f.api.get(`/api/carts/${second.cartId}`).expect(200);
  assert.equal(cart.body.total, "250.75");
  assert.equal(cart.body.items[0].available, false);
  const failed = await f.api
    .post(`/api/carts/${second.cartId}/checkout`)
    .set("Idempotency-Key", "new-order")
    .send({})
    .expect(409);
  assert.equal(failed.body.error.code, "INSUFFICIENT_INVENTORY");
  assert.deepEqual(f.service.getOrder(oldOrder.id), oldOrder);
  assert.equal(f.service.report().grossRevenue, "200.34");
  await f.api
    .patch(`/api/admin/products/${productId}`)
    .send({ inventory: 1 })
    .expect(200);
  const purchased = await f.api
    .post(`/api/carts/${second.cartId}/checkout`)
    .set("Idempotency-Key", "new-order")
    .send({})
    .expect(201);
  assert.equal(purchased.body.order.total, "250.75");
  assert.equal(purchased.body.order.items[0].name, "Revised Notebook");
  assert.equal(f.service.report().grossRevenue, "451.09");
  assert.deepEqual(f.service.getOrder(oldOrder.id), oldOrder);
});
