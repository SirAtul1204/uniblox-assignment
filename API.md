# HTTP API

Base URL: `http://localhost:3000/api`. Use `Content-Type: application/json` for bodies. All resource IDs are UUIDs, timestamps are UTC ISO strings, and monetary values are INR strings with exactly two fractional digits. Unknown body fields are rejected. Request bodies are limited to 16kb.

No authentication is implemented. Customer IDs are supplied by the caller. `/admin/*` operations are explicitly administrative.

## Shared representations

### Customer

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "name": "Asha",
  "createdAt": "2026-10-06T14:00:00.000Z"
}
```

### Product

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "name": "Notebook",
  "inventory": 100,
  "unitPrice": "200.34",
  "currency": "INR"
}
```

### Cart

```json
{
  "id": "22222222-2222-4222-8222-222222222222",
  "customerId": "11111111-1111-4111-8111-111111111111",
  "status": "open",
  "createdAt": "2026-10-06T14:00:00.000Z",
  "currency": "INR",
  "items": [
    {
      "productId": "00000000-0000-4000-8000-000000000001",
      "name": "Notebook",
      "quantity": 1,
      "unitPrice": "200.34",
      "lineTotal": "200.34",
      "availableInventory": 100,
      "available": true
    }
  ],
  "subtotal": "200.34",
  "discount": "0.00",
  "total": "200.34",
  "orderId": null
}
```

An empty cart has `items: []` and zero totals. Cart prices are live estimates, including when viewing a checked-out cart. A checked-out cart has `status: "checked_out"` and its `orderId`; retrieve that order for the actual immutable purchase prices. Cart totals do not preview a coupon discount. `available: false` means stock has fallen below the requested quantity since it was added.

### Order

```json
{
  "id": "33333333-3333-4333-8333-333333333333",
  "cartId": "22222222-2222-4222-8222-222222222222",
  "customerId": "11111111-1111-4111-8111-111111111111",
  "ordinal": 6,
  "currency": "INR",
  "createdAt": "2026-10-06T14:00:00.000Z",
  "items": [
    {
      "productId": "00000000-0000-4000-8000-000000000001",
      "name": "Notebook",
      "quantity": 1,
      "unitPrice": "200.34",
      "lineTotal": "200.34"
    }
  ],
  "subtotal": "200.34",
  "discount": "20.03",
  "total": "180.31",
  "appliedCoupon": { "code": "a-valid-generated-code", "discountPercent": 10 }
}
```

Without a coupon, `appliedCoupon` is `null` and `discount` is `"0.00"`. `ordinal` is the serialized store-wide successful order number. Orders have no update/delete endpoint.

### Coupon

```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "code": "83e29be224b770901bedcb6b152c3cd4",
  "customerId": "11111111-1111-4111-8111-111111111111",
  "milestoneOrderId": "55555555-5555-4555-8555-555555555555",
  "discountPercent": 10,
  "status": "available",
  "redeemedOrderId": null,
  "createdAt": "2026-10-06T14:00:00.000Z"
}
```

Codes are case-sensitive. Redemption changes `status` to `"redeemed"` and records `redeemedOrderId`. Coupons have no expiry and cannot be transferred to another customer.

## Endpoints

### `GET /health`

No body. **200**: `{ "status": "ok" }`. Checks database connectivity; startup checks schema readiness. Unexpected failures return **500**.

### `POST /customers`

Body: `{ "name": "Asha" }`. Trimmed name must contain 1–100 characters.

**201**: Customer. **400**: invalid body or empty name. Retrying customer creation can create another customer; checkout idempotency does not apply here.

### `GET /products`

No body. **200**: array of Product representations, including zero-stock products. Seed IDs are stable. Product creation, restocking, and price updates are not public endpoints in this assignment; tests change database fixtures to exercise those cases.

### `POST /carts`

Body: `{ "customerId": "11111111-1111-4111-8111-111111111111" }`.

**201**: empty Cart. **400**: invalid body/UUID. **404 `CUSTOMER_NOT_FOUND`**: customer does not exist. Retrying creates another cart.

### `GET /carts/:cartId`

No body. **200**: Cart. **400**: invalid UUID. **404 `CART_NOT_FOUND`**: missing cart.

### `PUT /carts/:cartId/items/:productId`

Body: `{ "quantity": 2 }`. Quantity must be a positive safe JSON integer, not a string. This endpoint both adds an item and replaces its existing quantity; it does not increment it. Identical requests are repeatable.

**200**: updated Cart. **400**: invalid body, UUID, quantity, or unsupported monetary range. **404**: missing cart/product. **409 `CART_ALREADY_CHECKED_OUT`**: cart closed. **409 `INSUFFICIENT_INVENTORY`**: requested quantity exceeds stock. No stock is reserved.

### `DELETE /carts/:cartId/items/:productId`

No body. **200**: updated Cart, including when the item was already absent. **400**: invalid UUID. **404 `CART_NOT_FOUND`**: missing cart. **409 `CART_ALREADY_CHECKED_OUT`**: cart closed. A nonexistent product ID in a valid UUID format is treated as an absent item.

### `POST /carts/:cartId/checkout`

Required header: `Idempotency-Key: a-client-generated-unique-key`. Keys are case-sensitive, contain 1–128 printable ASCII characters without whitespace, and are scoped to the cart's customer.

Body: `{}` or `{ "couponCode": "83e29be224b770901bedcb6b152c3cd4" }`. An omitted body is equivalent to `{}`. `null`, empty codes, and multiple coupons are rejected.

**201**:

```json
{
  "order": { "...": "Order representation above" },
  "earnedCoupon": null
}
```

The response contains the complete Order; `earnedCoupon` is the complete Coupon when this order reaches a milestone, otherwise `null`. That new coupon cannot discount its own earning order.

- **400**: invalid UUID, body/key, or amount outside the safe persisted range.
- **404 `CART_NOT_FOUND`**: missing cart.
- **409 `EMPTY_CART`**: no items.
- **409 `CART_ALREADY_CHECKED_OUT`**: completed cart with a new key.
- **409 `IDEMPOTENCY_CONFLICT`**: same customer/key with a different cart or coupon.
- **409 `INSUFFICIENT_INVENTORY`**: current inventory cannot satisfy the cart.
- **422 `COUPON_NOT_FOUND`**, **`COUPON_CUSTOMER_MISMATCH`**, or **`COUPON_ALREADY_REDEEMED`**: coupon is unusable.
- **503 `DATABASE_BUSY`**: lock timeout; retry with the same key.

After a successful commit, the same key, cart, and coupon replay the original **201** JSON response with `Idempotency-Replayed: true`. This works after a process restart, subsequent price changes, and later redemption of the earned coupon. The replayed earned coupon status is its original snapshot; use the customer coupon list for its current status.

Changing or omitting the original coupon on a successful retry is a conflict. Keys for failed attempts are not persisted; correct the problem and reuse the key. Inventory, coupon, cart, order ordinal, order, and successful replay record commit together or all roll back.

### `GET /orders/:orderId`

No body. **200**: Order. **400**: invalid UUID. **404 `ORDER_NOT_FOUND`**: missing order.

### `GET /customers/:customerId/coupons`

No body. **200**: array of Coupon representations, including redeemed coupons. **400**: invalid UUID. **404 `CUSTOMER_NOT_FOUND`**: missing customer.

### `POST /admin/coupons` — administrative

Body: `{}` or omitted. Arbitrary codes, owners, and percentages cannot be supplied.

**201**: Coupon for the oldest reached milestone missing its coupon, assigned to the milestone order's customer. **400**: unexpected body fields. **409 `NO_ELIGIBLE_MILESTONE`**: no eligible missing reward. **503 `DATABASE_BUSY`**: lock timeout.

Normal checkout automatically issues coupons, so this operation usually returns **409**. It supports recovery/import scenarios, not promotional campaigns. Eligibility and discount percentage come from the milestone order's historical policy snapshot, even after the active environment policy changes. No public API intentionally removes coupons to make a milestone eligible again.

### `GET /admin/report` — administrative

No body. **200**:

```json
{
  "currency": "INR",
  "purchasedQuantityByProduct": [
    {
      "productId": "00000000-0000-4000-8000-000000000001",
      "name": "Notebook",
      "quantity": 2
    },
    {
      "productId": "00000000-0000-4000-8000-000000000002",
      "name": "Pen",
      "quantity": 0
    }
  ],
  "grossRevenue": "400.68",
  "totalDiscounts": "20.03",
  "netRevenue": "380.65",
  "totalOrders": 2,
  "coupons": {
    "generated": 2,
    "available": 1,
    "redeemed": 1,
    "records": [{ "...": "complete Coupon representations" }]
  }
}
```

Product rows include every current product; examples above abbreviate the array. Product labels are current catalog names; historical purchased names remain in each order. Quantities aggregate order item snapshots. Revenue aggregates orders, so `grossRevenue - totalDiscounts = netRevenue`. Coupon counts reconcile with records. All queries use one consistent read transaction and do not mutate state. No pagination is implemented for this small assignment dataset.

## Error contract

```json
{
  "error": {
    "code": "INSUFFICIENT_INVENTORY",
    "message": "Requested quantity is unavailable",
    "details": {
      "productId": "00000000-0000-4000-8000-000000000005",
      "availableInventory": 1
    }
  }
}
```

`details` is optional. Clients should branch on `code`, not message text. Validation errors use `VALIDATION_ERROR` with Zod issues in `details`. Malformed JSON uses `400 INVALID_JSON`; oversized bodies use `413 BODY_TOO_LARGE`; unknown routes use `404 ROUTE_NOT_FOUND`. Unexpected failures use `500 INTERNAL_ERROR`, are logged server-side, and do not expose internal error details. Database write-lock timeout uses `503 DATABASE_BUSY` and `Retry-After: 1`.

Monetary conversion accepts canonical nonnegative decimal strings with at most two fractional digits, such as `"200"`, `"200.3"`, and `"200.34"`; output is always two digits. Negative amounts, exponent notation, extra precision, leading-zero whole amounts, and amounts over `"90071992547409.91"` are rejected by the money utility. The current HTTP API does not accept catalog price mutations. Cart/order totals must also fit that persisted bound. Report revenue uses BigInt accumulation and may exceed a single order's bound without rounding.

Run `npm run demo` for executable requests against a running server, or `npm run test:smoke` for the complete compiled-service evaluation on a fresh temporary database.
