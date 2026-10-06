import { and, asc, eq, sql } from "drizzle-orm";
import type { Executor } from "../db";
import {
  cartItems,
  carts,
  checkouts,
  coupons,
  customers,
  orderItems,
  orders,
  products,
} from "../db/schema";
import { AppError } from "../utils/errors";

// A repository is bound to the caller's connection or active transaction.
export class StoreRepository {
  constructor(readonly db: Executor) {}
  customer(id: string) {
    const row = this.db
      .select()
      .from(customers)
      .where(eq(customers.id, id))
      .get();
    if (!row)
      throw new AppError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
    return row;
  }
  cart(id: string, editable = false) {
    const row = this.db.select().from(carts).where(eq(carts.id, id)).get();
    if (!row) throw new AppError(404, "CART_NOT_FOUND", "Cart not found");
    if (editable && row.status !== "open")
      throw new AppError(
        409,
        "CART_ALREADY_CHECKED_OUT",
        "Cart has already been checked out",
      );
    return row;
  }
  product(id: string) {
    const row = this.db
      .select()
      .from(products)
      .where(eq(products.id, id))
      .get();
    if (!row) throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
    return row;
  }
  items(cartId: string) {
    return this.db
      .select({
        productId: products.id,
        name: products.name,
        priceMinor: products.priceMinor,
        inventory: products.inventory,
        quantity: cartItems.quantity,
      })
      .from(cartItems)
      .innerJoin(products, eq(cartItems.productId, products.id))
      .where(eq(cartItems.cartId, cartId))
      .orderBy(asc(products.id))
      .all();
  }
  order(id: string) {
    const row = this.db.select().from(orders).where(eq(orders.id, id)).get();
    if (!row) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    return row;
  }
  orderItems(id: string) {
    return this.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, id))
      .orderBy(asc(orderItems.productId))
      .all();
  }
  latestOrderOrdinal() {
    return (
      this.db
        .select({ ordinal: orders.ordinal })
        .from(orders)
        .orderBy(sql`${orders.ordinal} DESC`)
        .limit(1)
        .get()?.ordinal ?? 0
    );
  }
  checkout(customerId: string, key: string) {
    return this.db
      .select()
      .from(checkouts)
      .where(and(eq(checkouts.customerId, customerId), eq(checkouts.key, key)))
      .get();
  }
  coupon(code: string, customerId: string) {
    const row = this.db
      .select()
      .from(coupons)
      .where(eq(coupons.code, code))
      .get();
    if (!row)
      throw new AppError(422, "COUPON_NOT_FOUND", "Coupon code is invalid");
    if (row.customerId !== customerId)
      throw new AppError(
        422,
        "COUPON_CUSTOMER_MISMATCH",
        "Coupon belongs to another customer",
      );
    if (row.redeemedOrderId)
      throw new AppError(
        422,
        "COUPON_ALREADY_REDEEMED",
        "Coupon has already been redeemed",
      );
    return row;
  }
}
