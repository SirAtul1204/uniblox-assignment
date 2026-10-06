# Postman walkthrough

Import [checkout-rewards.postman_collection.json](checkout-rewards.postman_collection.json) into Postman. Start the backend with `npm run db:setup` and `npm run dev`, then select the collection, click **Run**, keep all requests selected, and run **one iteration** in their listed order. No environment file or manual ID copying is needed.

The collection variable `baseUrl` defaults to `http://localhost:3000/api`. Change it in the collection's Variables tab for another server. An environment variable with the same name takes precedence; avoid overriding the other variables captured by the scripts. You can also send requests individually in order; the collection scripts save the returned IDs and checkout keys.

The 38 requests cover:

1. Health, customer creation, a report baseline, product creation and price update, and catalog listing.
2. Cart creation, quantity replacement, removal, empty-checkout rejection, retry after correcting the cart, successful checkout, identical replay, immutable order retrieval, and completed-cart retrieval.
3. Four more purchases by the same customer, bringing this run to five successful orders.
4. Coupon listing, a sixth checkout using an earned coupon when available, redemption status, admin coupon recovery, report reconciliation, repeated read stability, and inventory verification.

Every run creates a new customer and dedicated stocked product, so previous runs and depleted seed inventory do not affect the walkthrough. Each complete run creates **six orders** and consumes six units of its product. The replay does not create another order. The scripts check exact paise arithmetic, revenue changes against the initial report, purchased quantity, coupon counts, and inventory.

With the default `REWARD_EVERY_N_ORDERS=5`, one of the first five orders always earns an owned coupon, even if the database already has orders. The sixth order redeems it. With a custom policy above five, this run may not earn a coupon; the sixth checkout then proceeds without a discount. Coupon percentages come from the actual earned coupon, including a 100% policy.

The empty checkout and admin recovery requests intentionally expect **409**; their assertions should pass. Recovery normally returns `NO_ELIGIBLE_MILESTONE` because issuance is automatic. Run against a migrated database without manually removed milestone coupons, and without concurrent writers, so the baseline and final report can reconcile exactly. Admin and customer requests assume trusted IDs because authentication is excluded from the assignment.

For command-line execution with [Newman](https://learning.postman.com/docs/collections/using-newman-cli/command-line-integration-with-newman/):

```sh
npx --yes newman run postman/checkout-rewards.postman_collection.json
```

To target another running instance:

```sh
npx --yes newman run postman/checkout-rewards.postman_collection.json --env-var "baseUrl=http://localhost:3001/api"
```

The command downloads Newman if needed; Newman is not an application dependency. The collection uses the Postman v2.1 format. Other clients can import its requests, but automatic variable capture and assertions depend on support for Postman's scripting API.
