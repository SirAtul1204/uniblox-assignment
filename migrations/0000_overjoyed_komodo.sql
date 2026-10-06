CREATE TABLE `cart_items` (
	`cart_id` text NOT NULL,
	`product_id` text NOT NULL,
	`quantity` integer NOT NULL,
	PRIMARY KEY(`cart_id`, `product_id`),
	FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cart_quantity_valid" CHECK("cart_items"."quantity" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `carts` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cart_status_valid" CHECK("carts"."status" IN ('open', 'checked_out'))
);
--> statement-breakpoint
CREATE TABLE `checkouts` (
	`customer_id` text NOT NULL,
	`key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`order_id` text NOT NULL,
	`response` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkouts_order_id_unique` ON `checkouts` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_customer_key` ON `checkouts` (`customer_id`,`key`);--> statement-breakpoint
CREATE TABLE `coupons` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`customer_id` text NOT NULL,
	`milestone_order_id` text NOT NULL,
	`percent` integer NOT NULL,
	`redeemed_order_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`milestone_order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`redeemed_order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "coupon_percent_valid" CHECK("coupons"."percent" BETWEEN 1 AND 100),
	CONSTRAINT "coupon_future_order" CHECK("coupons"."redeemed_order_id" IS NULL OR "coupons"."redeemed_order_id" != "coupons"."milestone_order_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coupons_code_unique` ON `coupons` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `coupons_milestone_order_id_unique` ON `coupons` (`milestone_order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `coupons_redeemed_order_id_unique` ON `coupons` (`redeemed_order_id`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`order_id` text NOT NULL,
	`product_id` text NOT NULL,
	`product_name` text NOT NULL,
	`unit_price_minor` integer NOT NULL,
	`quantity` integer NOT NULL,
	`line_total_minor` integer NOT NULL,
	PRIMARY KEY(`order_id`, `product_id`),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "order_item_valid" CHECK("order_items"."quantity" BETWEEN 1 AND 9007199254740991 AND "order_items"."unit_price_minor" BETWEEN 0 AND 9007199254740991 AND "order_items"."line_total_minor" BETWEEN 0 AND 9007199254740991 AND "order_items"."line_total_minor" = "order_items"."unit_price_minor" * "order_items"."quantity")
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`cart_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`subtotal_minor` integer NOT NULL,
	`discount_minor` integer NOT NULL,
	`total_minor` integer NOT NULL,
	`coupon_code` text,
	`coupon_percent` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "order_money_valid" CHECK("orders"."subtotal_minor" BETWEEN 0 AND 9007199254740991 AND "orders"."discount_minor" BETWEEN 0 AND "orders"."subtotal_minor" AND "orders"."total_minor" = "orders"."subtotal_minor" - "orders"."discount_minor"),
	CONSTRAINT "ordinal_valid" CHECK("orders"."ordinal" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "order_coupon_valid" CHECK(("orders"."coupon_code" IS NULL AND "orders"."coupon_percent" IS NULL) OR ("orders"."coupon_code" IS NOT NULL AND "orders"."coupon_percent" BETWEEN 1 AND 100))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_cart_id_unique` ON `orders` (`cart_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_ordinal_unique` ON `orders` (`ordinal`);--> statement-breakpoint
CREATE TABLE `reward_policy` (
	`id` integer PRIMARY KEY NOT NULL,
	`every_n` integer NOT NULL,
	`percent` integer NOT NULL,
	`order_count` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "singleton_policy" CHECK("reward_policy"."id" = 1),
	CONSTRAINT "policy_n_valid" CHECK("reward_policy"."every_n" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "policy_percent_valid" CHECK("reward_policy"."percent" BETWEEN 1 AND 100),
	CONSTRAINT "order_count_valid" CHECK("reward_policy"."order_count" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`price_minor` integer NOT NULL,
	`inventory` integer NOT NULL,
	CONSTRAINT "product_price_valid" CHECK("products"."price_minor" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "inventory_valid" CHECK("products"."inventory" BETWEEN 0 AND 9007199254740991)
);
