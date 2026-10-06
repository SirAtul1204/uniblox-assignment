import { Router } from "express";
import type { DatabaseContext } from "../db";
import { StoreController } from "../controllers/store";
import { StoreService, type StoreHooks } from "../services/store";

export function createRouter(context: DatabaseContext, hooks?: StoreHooks) {
  const router = Router();
  const controller = new StoreController(new StoreService(context.db, hooks));
  router.get("/health", (_req, res) => {
    context.sqlite.prepare("SELECT 1").get();
    res.json({ status: "ok" });
  });
  router.post("/customers", controller.createCustomer);
  router.get("/products", controller.products);
  router.post("/carts", controller.createCart);
  router.get("/carts/:cartId", controller.getCart);
  router.put("/carts/:cartId/items/:productId", controller.setItem);
  router.delete("/carts/:cartId/items/:productId", controller.removeItem);
  router.post("/carts/:cartId/checkout", controller.checkout);
  router.get("/orders/:orderId", controller.getOrder);
  router.get("/customers/:customerId/coupons", controller.coupons);
  router.post("/admin/coupons", controller.generateCoupon);
  router.get("/admin/report", controller.report);
  return router;
}
