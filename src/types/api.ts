export interface CouponView {
  id: string;
  code: string;
  customerId: string;
  milestoneOrderId: string;
  discountPercent: number;
  status: "available" | "redeemed";
  redeemedOrderId: string | null;
  createdAt: string;
}
export interface OrderView {
  id: string;
  cartId: string;
  customerId: string;
  ordinal: number;
  currency: "INR";
  items: {
    productId: string;
    name: string;
    quantity: number;
    unitPrice: string;
    lineTotal: string;
  }[];
  subtotal: string;
  discount: string;
  total: string;
  appliedCoupon: { code: string; discountPercent: number } | null;
  createdAt: string;
}
export interface CheckoutResponse {
  order: OrderView;
  earnedCoupon: CouponView | null;
}
