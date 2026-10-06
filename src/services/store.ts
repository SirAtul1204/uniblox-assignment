import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";
import type { Db, Executor, RewardPolicy } from "../db";
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
import { StoreRepository } from "../repositories/store";
import type { CheckoutResponse, CouponView, OrderView } from "../types/api";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { calculateTotals, formatMoney, safeInteger } from "../utils/money";

function couponView(row: typeof coupons.$inferSelect): CouponView {
  return {
    id: row.id,
    code: row.code,
    customerId: row.customerId,
    milestoneOrderId: row.milestoneOrderId,
    discountPercent: row.percent,
    status: row.redeemedOrderId ? "redeemed" : "available",
    redeemedOrderId: row.redeemedOrderId,
    createdAt: row.createdAt,
  };
}
function orderView(repo: StoreRepository, id: string): OrderView {
  const row = repo.order(id);
  return {
    id: row.id,
    cartId: row.cartId,
    customerId: row.customerId,
    ordinal: row.ordinal,
    currency: "INR",
    createdAt: row.createdAt,
    items: repo.orderItems(id).map((item) => ({
      productId: item.productId,
      name: item.productName,
      quantity: item.quantity,
      unitPrice: formatMoney(item.unitPriceMinor),
      lineTotal: formatMoney(item.lineTotalMinor),
    })),
    subtotal: formatMoney(row.subtotalMinor),
    discount: formatMoney(row.discountMinor),
    total: formatMoney(row.totalMinor),
    appliedCoupon:
      row.couponCode === null
        ? null
        : { code: row.couponCode, discountPercent: row.couponPercent! },
  };
}
function cartView(repo: StoreRepository, id: string) {
  const cart = repo.cart(id);
  const currentItems = repo.items(id);
  const items = currentItems.map((item) => ({
    productId: item.productId,
    name: item.name,
    quantity: item.quantity,
    unitPrice: formatMoney(item.priceMinor),
    lineTotal: formatMoney(
      safeInteger(BigInt(item.priceMinor) * BigInt(item.quantity)),
    ),
    availableInventory: item.inventory,
    available: item.quantity <= item.inventory,
  }));
  const subtotal = safeInteger(
    currentItems.reduce(
      (sum, item) => sum + BigInt(item.priceMinor) * BigInt(item.quantity),
      0n,
    ),
  );
  const order = repo.db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.cartId, id))
    .get();
  return {
    ...cart,
    currency: "INR",
    items,
    subtotal: formatMoney(subtotal),
    discount: "0.00",
    total: formatMoney(subtotal),
    orderId: order?.id ?? null,
  };
}

// Test-only hook enables proof of rollback after mutations; never exposed over HTTP.
export interface StoreHooks {
  afterCheckoutMutations?: () => void;
}
export class StoreService {
  constructor(
    private readonly db: Db,
    private readonly reward: RewardPolicy = env,
    private readonly hooks: StoreHooks = {},
  ) {}

  createCustomer(name: string) {
    const row = { id: randomUUID(), name, createdAt: new Date().toISOString() };
    this.db.insert(customers).values(row).run();
    return row;
  }
  listProducts() {
    return this.db
      .select()
      .from(products)
      .orderBy(asc(products.id))
      .all()
      .map(({ priceMinor, ...row }) => ({
        ...row,
        unitPrice: formatMoney(priceMinor),
        currency: "INR",
      }));
  }
  createCart(customerId: string) {
    return this.db.transaction(
      (tx) => {
        const repo = new StoreRepository(tx);
        repo.customer(customerId);
        const id = randomUUID();
        tx.insert(carts)
          .values({ id, customerId, createdAt: new Date().toISOString() })
          .run();
        return cartView(repo, id);
      },
      { behavior: "immediate" },
    );
  }
  getCart(id: string) {
    return this.db.transaction((tx) => cartView(new StoreRepository(tx), id));
  }
  setItem(cartId: string, productId: string, quantity: number) {
    return this.db.transaction(
      (tx) => {
        const repo = new StoreRepository(tx);
        repo.cart(cartId, true);
        const product = repo.product(productId);
        if (quantity > product.inventory)
          throw new AppError(
            409,
            "INSUFFICIENT_INVENTORY",
            "Requested quantity is unavailable",
            { productId, availableInventory: product.inventory },
          );
        tx.insert(cartItems)
          .values({ cartId, productId, quantity })
          .onConflictDoUpdate({
            target: [cartItems.cartId, cartItems.productId],
            set: { quantity },
          })
          .run();
        return cartView(repo, cartId);
      },
      { behavior: "immediate" },
    );
  }
  removeItem(cartId: string, productId: string) {
    return this.db.transaction(
      (tx) => {
        const repo = new StoreRepository(tx);
        repo.cart(cartId, true);
        tx.delete(cartItems)
          .where(
            and(
              eq(cartItems.cartId, cartId),
              eq(cartItems.productId, productId),
            ),
          )
          .run();
        return cartView(repo, cartId);
      },
      { behavior: "immediate" },
    );
  }
  private generateReward(
    tx: Executor,
    order: typeof orders.$inferSelect,
  ): CouponView {
    if (order.ordinal % order.rewardEveryN !== 0)
      throw new AppError(
        409,
        "NO_ELIGIBLE_MILESTONE",
        "Order is not an eligible milestone",
      );
    const row = {
      id: randomUUID(),
      code: randomBytes(16).toString("hex"),
      customerId: order.customerId,
      milestoneOrderId: order.id,
      percent: order.rewardPercent,
      redeemedOrderId: null,
      createdAt: new Date().toISOString(),
    };
    tx.insert(coupons).values(row).run();
    return couponView(row);
  }
  checkout(
    cartId: string,
    key: string,
    couponCode?: string,
  ): { response: CheckoutResponse; replayed: boolean } {
    return this.db.transaction(
      (tx) => {
        const repo = new StoreRepository(tx);
        const cart = repo.cart(cartId);
        const fingerprint = JSON.stringify({
          cartId,
          couponCode: couponCode ?? null,
        });
        const previous = repo.checkout(cart.customerId, key);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new AppError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Idempotency key was used for a different checkout",
            );
          return {
            response: JSON.parse(previous.response) as CheckoutResponse,
            replayed: true,
          };
        }
        repo.cart(cartId, true);
        const items = repo.items(cartId);
        if (!items.length)
          throw new AppError(
            409,
            "EMPTY_CART",
            "Cannot check out an empty cart",
          );
        for (const item of items) {
          if (item.quantity > item.inventory)
            throw new AppError(
              409,
              "INSUFFICIENT_INVENTORY",
              "Requested quantity is unavailable",
              { productId: item.productId, availableInventory: item.inventory },
            );
        }
        const coupon = couponCode
          ? repo.coupon(couponCode, cart.customerId)
          : null;
        const subtotal = safeInteger(
          items.reduce(
            (sum, item) =>
              sum + BigInt(item.priceMinor) * BigInt(item.quantity),
            0n,
          ),
        );
        const totals = calculateTotals(subtotal, coupon?.percent);
        const reward = this.reward;
        const ordinal = safeInteger(BigInt(repo.latestOrderOrdinal()) + 1n);
        const order = {
          id: randomUUID(),
          cartId,
          customerId: cart.customerId,
          ordinal,
          rewardEveryN: reward.everyN,
          rewardPercent: reward.percent,
          ...totals,
          couponCode: coupon?.code ?? null,
          couponPercent: coupon?.percent ?? null,
          createdAt: new Date().toISOString(),
        };
        for (const item of items) {
          const changed = tx
            .update(products)
            .set({ inventory: sql`${products.inventory} - ${item.quantity}` })
            .where(
              and(
                eq(products.id, item.productId),
                gte(products.inventory, item.quantity),
              ),
            )
            .run();
          if (changed.changes !== 1)
            throw new AppError(
              409,
              "INSUFFICIENT_INVENTORY",
              "Inventory changed before purchase",
            );
        }
        // Insert before redemption because redeemedOrderId is a foreign key.
        tx.insert(orders).values(order).run();
        for (const item of items)
          tx.insert(orderItems)
            .values({
              orderId: order.id,
              productId: item.productId,
              productName: item.name,
              unitPriceMinor: item.priceMinor,
              quantity: item.quantity,
              lineTotalMinor: safeInteger(
                BigInt(item.priceMinor) * BigInt(item.quantity),
              ),
            })
            .run();
        if (coupon) {
          const changed = tx
            .update(coupons)
            .set({ redeemedOrderId: order.id })
            .where(
              and(
                eq(coupons.id, coupon.id),
                eq(coupons.customerId, cart.customerId),
                isNull(coupons.redeemedOrderId),
              ),
            )
            .run();
          if (changed.changes !== 1)
            throw new AppError(
              422,
              "COUPON_ALREADY_REDEEMED",
              "Coupon has already been redeemed",
            );
        }
        this.hooks.afterCheckoutMutations?.();
        tx.update(carts)
          .set({ status: "checked_out" })
          .where(eq(carts.id, cartId))
          .run();
        const earnedCoupon =
          ordinal % reward.everyN === 0 ? this.generateReward(tx, order) : null;
        const response: CheckoutResponse = {
          order: orderView(repo, order.id),
          earnedCoupon,
        };
        tx.insert(checkouts)
          .values({
            customerId: cart.customerId,
            key,
            fingerprint,
            orderId: order.id,
            response: JSON.stringify(response),
          })
          .run();
        return { response, replayed: false };
      },
      { behavior: "immediate" },
    );
  }
  getOrder(id: string) {
    return this.db.transaction((tx) => orderView(new StoreRepository(tx), id));
  }
  customerCoupons(customerId: string) {
    return this.db.transaction((tx) => {
      new StoreRepository(tx).customer(customerId);
      return tx
        .select()
        .from(coupons)
        .where(eq(coupons.customerId, customerId))
        .orderBy(asc(coupons.createdAt), asc(coupons.id))
        .all()
        .map(couponView);
    });
  }
  generateCoupon() {
    return this.db.transaction(
      (tx) => {
        const eligible = tx
          .select({ order: orders })
          .from(orders)
          .leftJoin(coupons, eq(orders.id, coupons.milestoneOrderId))
          .where(
            and(
              sql`${orders.ordinal} % ${orders.rewardEveryN} = 0`,
              isNull(coupons.id),
            ),
          )
          .orderBy(asc(orders.ordinal))
          .get();
        if (!eligible)
          throw new AppError(
            409,
            "NO_ELIGIBLE_MILESTONE",
            "No unrewarded milestone exists",
          );
        return this.generateReward(tx, eligible.order);
      },
      { behavior: "immediate" },
    );
  }
  report() {
    return this.db.transaction((tx) => {
      // BigInt aggregation avoids SQLite SUM overflow and JS rounding across many orders.
      const allOrders = tx.select().from(orders).all();
      const allItems = tx.select().from(orderItems).all();
      const allCoupons = tx
        .select()
        .from(coupons)
        .orderBy(asc(coupons.createdAt), asc(coupons.id))
        .all()
        .map(couponView);
      const quantities = new Map<string, bigint>();
      for (const item of allItems)
        quantities.set(
          item.productId,
          (quantities.get(item.productId) ?? 0n) + BigInt(item.quantity),
        );
      const purchased = tx
        .select()
        .from(products)
        .orderBy(asc(products.id))
        .all()
        .map((product) => ({
          productId: product.id,
          name: product.name,
          quantity: safeInteger(quantities.get(product.id) ?? 0n),
        }));
      const gross = allOrders.reduce(
        (sum, order) => sum + BigInt(order.subtotalMinor),
        0n,
      );
      const discounts = allOrders.reduce(
        (sum, order) => sum + BigInt(order.discountMinor),
        0n,
      );
      const net = allOrders.reduce(
        (sum, order) => sum + BigInt(order.totalMinor),
        0n,
      );
      return {
        currency: "INR",
        purchasedQuantityByProduct: purchased,
        grossRevenue: formatMoney(gross),
        totalDiscounts: formatMoney(discounts),
        netRevenue: formatMoney(net),
        totalOrders: allOrders.length,
        coupons: {
          generated: allCoupons.length,
          available: allCoupons.filter((c) => c.status === "available").length,
          redeemed: allCoupons.filter((c) => c.status === "redeemed").length,
          records: allCoupons,
        },
      };
    });
  }
}
