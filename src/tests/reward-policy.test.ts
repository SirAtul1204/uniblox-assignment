import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { assertReady, openDatabase } from "../db";
import { coupons, orders } from "../db/schema";
import { seed } from "../db/seed";
import { StoreService } from "../services/store";
import { fixture, populatedCart, productId } from "./helpers";

test("changed environment policy applies to new orders, retaining coupon percentages and replay", (t) => {
  const f = fixture(t, { policy: { everyN: 2, percent: 10 } });
  const first = populatedCart(f.service);
  f.service.checkout(first.cartId, "first");
  const second = populatedCart(f.service, first.customerId);
  const original = f.service.checkout(second.cartId, "second").response;
  assert.equal(original.earnedCoupon!.discountPercent, 10);

  // A restarted app receives the newly parsed environment policy, not a DB setting.
  const restarted = new StoreService(f.db, { everyN: 3, percent: 25 });
  assertReady(f.db);
  const third = populatedCart(restarted, first.customerId);
  assert.equal(
    restarted.checkout(third.cartId, "third").response.earnedCoupon!
      .discountPercent,
    25,
  );
  const fourth = populatedCart(restarted, first.customerId);
  const result = restarted.checkout(
    fourth.cartId,
    "fourth",
    original.earnedCoupon!.code,
  ).response;
  assert.equal(result.order.discount, "20.03");
  assert.equal(result.earnedCoupon, null);
  assert.deepEqual(
    restarted.checkout(second.cartId, "second").response,
    original,
  );
  const snapshots = f.db.select().from(orders).orderBy(orders.ordinal).all();
  assert.deepEqual(
    snapshots.map((row) => [row.rewardEveryN, row.rewardPercent]),
    [
      [2, 10],
      [2, 10],
      [3, 25],
      [3, 25],
    ],
  );
  assert.equal(
    f.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE name = 'reward_policy'")
      .get(),
    undefined,
  );
});

test("admin recovery follows historical eligibility and discount, not current environment", (t) => {
  const f = fixture(t, { policy: { everyN: 2, percent: 10 } });
  const first = populatedCart(f.service);
  f.service.checkout(first.cartId, "one");
  const second = populatedCart(f.service, first.customerId);
  const oldReward = f.service.checkout(second.cartId, "two").response
    .earnedCoupon!;
  f.db.delete(coupons).where(eq(coupons.id, oldReward.id)).run();
  const restarted = new StoreService(f.db, { everyN: 1, percent: 50 });
  const repaired = restarted.generateCoupon();
  assert.equal(repaired.milestoneOrderId, oldReward.milestoneOrderId);
  assert.equal(repaired.discountPercent, 10);
  assert.throws(() => restarted.generateCoupon(), /No unrewarded milestone/);
});

test("migration backfills legacy orders before dropping policy and preserves replay records", (t) => {
  const f = fixture(t);
  const legacyFolder = join(f.dir, "legacy-migrations");
  mkdirSync(join(legacyFolder, "meta"), { recursive: true });
  const journal = JSON.parse(
    readFileSync(resolve("migrations/meta/_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.slice(0, 1);
  writeFileSync(
    join(legacyFolder, "meta/_journal.json"),
    JSON.stringify(journal),
  );
  const initialSql = journal.entries[0].tag + ".sql";
  writeFileSync(
    join(legacyFolder, initialSql),
    readFileSync(resolve("migrations", initialSql)),
  );
  const legacy = openDatabase(":memory:");
  try {
    migrate(legacy.db, { migrationsFolder: legacyFolder });
    seed(legacy.db);
    legacy.sqlite
      .prepare(
        "INSERT INTO reward_policy (id,every_n,percent,order_count) VALUES (1,2,17,2)",
      )
      .run();
    const customerId = randomUUID();
    const createdAt = new Date().toISOString();
    legacy.sqlite
      .prepare("INSERT INTO customers (id,name,created_at) VALUES (?,?,?)")
      .run(customerId, "Legacy", createdAt);
    let milestone = "";
    for (let ordinal = 1; ordinal <= 2; ordinal++) {
      const cartId = randomUUID();
      const orderId = randomUUID();
      legacy.sqlite
        .prepare(
          "INSERT INTO carts (id,customer_id,status,created_at) VALUES (?,?,'checked_out',?)",
        )
        .run(cartId, customerId, createdAt);
      legacy.sqlite
        .prepare(
          "INSERT INTO orders (id,cart_id,customer_id,ordinal,subtotal_minor,discount_minor,total_minor,created_at) VALUES (?,?,?,?,20034,0,20034,?)",
        )
        .run(orderId, cartId, customerId, ordinal, createdAt);
      legacy.sqlite
        .prepare(
          "INSERT INTO order_items (order_id,product_id,product_name,unit_price_minor,quantity,line_total_minor) VALUES (?,?,'Notebook',20034,1,20034)",
        )
        .run(orderId, productId);
      if (ordinal === 2) milestone = orderId;
    }
    const storedResponse = JSON.stringify({ original: "durable response" });
    legacy.sqlite
      .prepare(
        "INSERT INTO checkouts (customer_id,key,fingerprint,order_id,response) VALUES (?,'legacy-key','legacy-fingerprint',?,?)",
      )
      .run(customerId, milestone, storedResponse);
    migrate(legacy.db, { migrationsFolder: resolve("migrations") });
    assertReady(legacy.db);
    const snapshot = legacy.db
      .select()
      .from(orders)
      .where(eq(orders.id, milestone))
      .get()!;
    assert.equal(snapshot.rewardEveryN, 2);
    assert.equal(snapshot.rewardPercent, 17);
    assert.deepEqual(
      legacy.sqlite
        .prepare("SELECT response FROM checkouts WHERE key = 'legacy-key'")
        .get(),
      { response: storedResponse },
    );
    const service = new StoreService(legacy.db, { everyN: 7, percent: 50 });
    assert.equal(service.generateCoupon().discountPercent, 17);
    const cart = populatedCart(service, customerId);
    assert.equal(
      service.checkout(cart.cartId, "new-policy").response.order.ordinal,
      3,
    );
    assert.equal(
      legacy.db
        .select()
        .from(orders)
        .where(eq(orders.cartId, cart.cartId))
        .get()!.rewardEveryN,
      7,
    );
  } finally {
    legacy.sqlite.close();
  }
});
