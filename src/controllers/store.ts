import type { RequestHandler } from "express";
import { z } from "zod";
import type { StoreService } from "../services/store";

const id = z.string().uuid();
const cartParams = z.object({ cartId: id });
const itemParams = z.object({ cartId: id, productId: id });
const keySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7E]+$/);
const emptyBody = z.object({}).strict();

export class StoreController {
  constructor(private readonly service: StoreService) {}
  createCustomer: RequestHandler = (req, res) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(100) })
      .strict()
      .parse(req.body);
    res.status(201).json(this.service.createCustomer(body.name));
  };
  products: RequestHandler = (_req, res) => {
    res.json(this.service.listProducts());
  };
  createCart: RequestHandler = (req, res) => {
    const body = z.object({ customerId: id }).strict().parse(req.body);
    res.status(201).json(this.service.createCart(body.customerId));
  };
  getCart: RequestHandler = (req, res) => {
    const { cartId } = cartParams.parse(req.params);
    res.json(this.service.getCart(cartId));
  };
  setItem: RequestHandler = (req, res) => {
    const { cartId, productId } = itemParams.parse(req.params);
    const { quantity } = z
      .object({
        quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .parse(req.body);
    res.json(this.service.setItem(cartId, productId, quantity));
  };
  removeItem: RequestHandler = (req, res) => {
    const { cartId, productId } = itemParams.parse(req.params);
    res.json(this.service.removeItem(cartId, productId));
  };
  checkout: RequestHandler = (req, res) => {
    const { cartId } = cartParams.parse(req.params);
    const key = keySchema.parse(req.get("Idempotency-Key"));
    const { couponCode } = z
      .object({ couponCode: z.string().min(1).max(128).optional() })
      .strict()
      .parse(req.body ?? {});
    const result = this.service.checkout(cartId, key, couponCode);
    if (result.replayed) res.set("Idempotency-Replayed", "true");
    res.status(201).json(result.response);
  };
  getOrder: RequestHandler = (req, res) => {
    const { orderId } = z.object({ orderId: id }).parse(req.params);
    res.json(this.service.getOrder(orderId));
  };
  coupons: RequestHandler = (req, res) => {
    const { customerId } = z.object({ customerId: id }).parse(req.params);
    res.json(this.service.customerCoupons(customerId));
  };
  generateCoupon: RequestHandler = (req, res) => {
    emptyBody.parse(req.body ?? {});
    res.status(201).json(this.service.generateCoupon());
  };
  report: RequestHandler = (_req, res) => {
    res.json(this.service.report());
  };
}
