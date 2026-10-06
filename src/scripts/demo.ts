import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { CheckoutResponse, CouponView } from "../types/api";

interface Product {
  id: string;
  name: string;
  unitPrice: string;
  inventory: number;
}
async function main() {
  const base = (
    process.env.API_BASE_URL ?? "http://localhost:3000/api"
  ).replace(/\/$/, "");
  async function call<T>(
    method: string,
    route: string,
    expected: number,
    body?: unknown,
    key?: string,
  ): Promise<{ body: T; headers: Headers }> {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json();
    assert.equal(
      response.status,
      expected,
      `${method} ${route}: ${JSON.stringify(result)}`,
    );
    return { body: result as T, headers: response.headers };
  }
  await call("GET", "/health", 200);
  const customer = (
    await call<{ id: string }>("POST", "/customers", 201, {
      name: "Evaluation Customer",
    })
  ).body;
  const products = (await call<Product[]>("GET", "/products", 200)).body;
  const product = products.find((item) => item.inventory > 0);
  assert.ok(
    product,
    "Seed products and ensure stock is available before running the demo",
  );
  const cart = (
    await call<{ id: string }>("POST", "/carts", 201, {
      customerId: customer.id,
    })
  ).body;
  await call("PUT", `/carts/${cart.id}/items/${product.id}`, 200, {
    quantity: 1,
  });
  await call("GET", `/carts/${cart.id}`, 200);
  const key = randomUUID();
  const first = await call<CheckoutResponse>(
    "POST",
    `/carts/${cart.id}/checkout`,
    201,
    {},
    key,
  );
  const replay = await call<CheckoutResponse>(
    "POST",
    `/carts/${cart.id}/checkout`,
    201,
    {},
    key,
  );
  assert.deepEqual(replay.body, first.body);
  assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
  await call("GET", `/orders/${first.body.order.id}`, 200);
  await call("GET", `/customers/${customer.id}/coupons`, 200);
  if (first.body.earnedCoupon) {
    const next = (
      await call<{ id: string }>("POST", "/carts", 201, {
        customerId: customer.id,
      })
    ).body;
    await call("PUT", `/carts/${next.id}/items/${product.id}`, 200, {
      quantity: 1,
    });
    const discounted = await call<CheckoutResponse>(
      "POST",
      `/carts/${next.id}/checkout`,
      201,
      { couponCode: first.body.earnedCoupon.code },
      randomUUID(),
    );
    console.log(
      "Discounted order:",
      JSON.stringify(discounted.body.order, null, 2),
    );
  }
  // Administrative recovery may create a coupon or report no missing milestone.
  const admin = await fetch(`${base}/admin/coupons`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(admin.status === 201 || admin.status === 409);
  const adminBody = (await admin.json()) as
    | CouponView
    | { error: { code: string } };
  if (admin.status === 409)
    assert.equal(
      "error" in adminBody && adminBody.error.code,
      "NO_ELIGIBLE_MILESTONE",
    );
  console.log("Checkout:", JSON.stringify(first.body, null, 2));
  console.log(
    "Report:",
    JSON.stringify((await call("GET", "/admin/report", 200)).body, null, 2),
  );
  console.log("Evaluation walkthrough passed, including checkout replay.");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
