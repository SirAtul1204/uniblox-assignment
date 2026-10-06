import { sql } from "drizzle-orm";
import {
  check,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const max = sql.raw(String(Number.MAX_SAFE_INTEGER));
export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});
export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    priceMinor: integer("price_minor").notNull(),
    inventory: integer("inventory").notNull(),
  },
  (t) => [
    check("product_price_valid", sql`${t.priceMinor} BETWEEN 0 AND ${max}`),
    check("inventory_valid", sql`${t.inventory} BETWEEN 0 AND ${max}`),
  ],
);
export const carts = sqliteTable(
  "carts",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    status: text("status", { enum: ["open", "checked_out"] })
      .notNull()
      .default("open"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("cart_status_valid", sql`${t.status} IN ('open', 'checked_out')`),
  ],
);
export const cartItems = sqliteTable(
  "cart_items",
  {
    cartId: text("cart_id")
      .notNull()
      .references(() => carts.id),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    quantity: integer("quantity").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.cartId, t.productId] }),
    check("cart_quantity_valid", sql`${t.quantity} BETWEEN 1 AND ${max}`),
  ],
);
export const policy = sqliteTable(
  "reward_policy",
  {
    id: integer("id").primaryKey(),
    everyN: integer("every_n").notNull(),
    percent: integer("percent").notNull(),
    orderCount: integer("order_count").notNull().default(0),
  },
  (t) => [
    check("singleton_policy", sql`${t.id} = 1`),
    check("policy_n_valid", sql`${t.everyN} BETWEEN 1 AND ${max}`),
    check("policy_percent_valid", sql`${t.percent} BETWEEN 1 AND 100`),
    check("order_count_valid", sql`${t.orderCount} BETWEEN 0 AND ${max}`),
  ],
);
export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    cartId: text("cart_id")
      .notNull()
      .unique()
      .references(() => carts.id),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    ordinal: integer("ordinal").notNull().unique(),
    subtotalMinor: integer("subtotal_minor").notNull(),
    discountMinor: integer("discount_minor").notNull(),
    totalMinor: integer("total_minor").notNull(),
    couponCode: text("coupon_code"),
    couponPercent: integer("coupon_percent"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check(
      "order_money_valid",
      sql`${t.subtotalMinor} BETWEEN 0 AND ${max} AND ${t.discountMinor} BETWEEN 0 AND ${t.subtotalMinor} AND ${t.totalMinor} = ${t.subtotalMinor} - ${t.discountMinor}`,
    ),
    check("ordinal_valid", sql`${t.ordinal} BETWEEN 1 AND ${max}`),
    check(
      "order_coupon_valid",
      sql`(${t.couponCode} IS NULL AND ${t.couponPercent} IS NULL) OR (${t.couponCode} IS NOT NULL AND ${t.couponPercent} BETWEEN 1 AND 100)`,
    ),
  ],
);
export const orderItems = sqliteTable(
  "order_items",
  {
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    productName: text("product_name").notNull(),
    unitPriceMinor: integer("unit_price_minor").notNull(),
    quantity: integer("quantity").notNull(),
    lineTotalMinor: integer("line_total_minor").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.productId] }),
    check(
      "order_item_valid",
      sql`${t.quantity} BETWEEN 1 AND ${max} AND ${t.unitPriceMinor} BETWEEN 0 AND ${max} AND ${t.lineTotalMinor} BETWEEN 0 AND ${max} AND ${t.lineTotalMinor} = ${t.unitPriceMinor} * ${t.quantity}`,
    ),
  ],
);
export const coupons = sqliteTable(
  "coupons",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    milestoneOrderId: text("milestone_order_id")
      .notNull()
      .unique()
      .references(() => orders.id),
    percent: integer("percent").notNull(),
    redeemedOrderId: text("redeemed_order_id")
      .unique()
      .references(() => orders.id),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("coupon_percent_valid", sql`${t.percent} BETWEEN 1 AND 100`),
    check(
      "coupon_future_order",
      sql`${t.redeemedOrderId} IS NULL OR ${t.redeemedOrderId} != ${t.milestoneOrderId}`,
    ),
  ],
);
export const checkouts = sqliteTable(
  "checkouts",
  {
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    key: text("key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    orderId: text("order_id")
      .notNull()
      .unique()
      .references(() => orders.id),
    response: text("response").notNull(),
  },
  (t) => [uniqueIndex("checkout_customer_key").on(t.customerId, t.key)],
);
