import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import definition from "../docs/openapi.json";
import { fixture, productId } from "./helpers";

test("OpenAPI document validates and covers every public API operation", async () => {
  await SwaggerParser.validate(resolve("src/docs/openapi.json"));
  const expected = [
    "GET /health",
    "POST /customers",
    "GET /products",
    "POST /carts",
    "GET /carts/{cartId}",
    "PUT /carts/{cartId}/items/{productId}",
    "DELETE /carts/{cartId}/items/{productId}",
    "POST /carts/{cartId}/checkout",
    "GET /orders/{orderId}",
    "GET /customers/{customerId}/coupons",
    "POST /admin/coupons",
    "GET /admin/report",
  ];
  const actual = Object.entries(definition.paths).flatMap(
    ([path, operations]) =>
      Object.keys(operations).map(
        (method) => `${method.toUpperCase()} ${path}`,
      ),
  );
  assert.deepEqual(actual.sort(), expected.sort());
  assert.deepEqual(definition.servers, [
    {
      url: "/api",
      description: "This server; works with any host or port serving the docs.",
    },
  ]);
});

test("Swagger UI and its same-origin spec are served without mutating the database", async (t) => {
  const f = fixture(t);
  const changes = f.sqlite.prepare("SELECT total_changes() AS count").get();
  const page = await f.api
    .get("/docs/")
    .expect(200)
    .expect("Content-Type", /html/);
  assert.match(page.text, /Checkout and Rewards API/);
  assert.match(page.text, /swagger-ui-bundle\.js/);
  const init = await f.api.get("/docs/swagger-ui-init.js").expect(200);
  assert.match(init.text, /\/openapi\.json/);
  assert.match(init.text, /"tryItOutEnabled": true/);
  assert.match(init.text, /"validatorUrl": null/);
  await f.api.get("/docs/swagger-ui-bundle.js").expect(200);
  await f.api.get("/docs/swagger-ui.css").expect(200);
  const spec = await f.api
    .get("/openapi.json")
    .expect(200)
    .expect("Content-Type", /json/);
  assert.deepEqual(spec.body, definition);
  assert.deepEqual(
    f.sqlite.prepare("SELECT total_changes() AS count").get(),
    changes,
  );
});

test("the documented browser walkthrough creates a cart and replays checkout", async (t) => {
  const f = fixture(t);
  const customer = await f.api
    .post("/api/customers")
    .send({ name: "Swagger Reviewer" })
    .expect(201);
  const cart = await f.api
    .post("/api/carts")
    .send({ customerId: customer.body.id })
    .expect(201);
  await f.api
    .put(`/api/carts/${cart.body.id}/items/${productId}`)
    .send({ quantity: 1 })
    .expect(200);
  const route = `/api/carts/${cart.body.id}/checkout`;
  const first = await f.api
    .post(route)
    .set("Idempotency-Key", "swagger-001")
    .send({})
    .expect(201);
  assert.equal(first.body.order.total, "200.34");
  assert.equal(first.body.earnedCoupon, null);
  const replay = await f.api
    .post(route)
    .set("Idempotency-Key", "swagger-001")
    .send({})
    .expect(201);
  assert.deepEqual(replay.body, first.body);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  await f.api.get(`/api/orders/${first.body.order.id}`).expect(200);
  await f.api.get("/api/admin/report").expect(200);
});
