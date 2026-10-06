# Design Decisions

This document describes the current implementation against the [backend assignment](https://github.com/neustackapp/assignment/blob/main/be/README.md). Later user-approved changes supersede the original implementation plan: active reward policy comes only from environment variables, and the database stores historical order snapshots rather than an active policy or singleton counter. Product administration, diagrams, Swagger UI, and a Postman walkthrough were added during follow-up work.

## Ambiguities and selected semantics

| Unspecified behavior                 | Selected rule                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Milestone scope and order            | Store-wide committed order ordinal; discounted orders count; failures and replays do not. Concurrent arrival order does not determine the winner. |
| Reward ownership                     | The customer placing the milestone order owns its coupon; it is not a public bearer promotion.                                                    |
| Automatic versus admin issuance      | Checkout issues atomically; admin generation recovers the oldest eligible missing reward, one per request.                                        |
| Coupon lifecycle                     | Single redemption, no expiry, at most one coupon per checkout, usable only after the earning order.                                               |
| Price or stock changes               | No reservations or locked cart prices; revalidate current products at checkout and preserve purchase snapshots.                                   |
| Quantity changes and removals        | PUT replaces absolute quantity; deleting an absent item from an open cart is a no-op.                                                             |
| Payment success                      | Successful SQLite commit represents payment success; no provider is called.                                                                       |
| Policy changes                       | Restart applies new environment values to future orders; old order eligibility and coupon percentages remain unchanged.                           |
| Customer identity and administration | Trusted customer IDs; `/api/admin/products`, `/api/admin/coupons`, and `/api/admin/report` are administrative operations without authentication.  |
| Product stock updates                | Admin PATCH sets absolute available inventory; product deletion is not provided.                                                                  |

## Invariants

1. Inventory never becomes negative; only a committed purchase consumes it.
2. A cart creates at most one order and cannot be changed after checkout.
3. Successful retries replay one durable response without additional inventory, orders, or rewards.
4. A coupon belongs to one customer, is generated once per milestone, and is redeemed by at most one later order.
5. Failed checkout consumes no stock or coupon and advances no successful-order ordinal.
6. Orders retain the product and pricing facts used at purchase time.
7. Money calculations are exact; discounts cannot exceed subtotal.
8. Reports reconcile with stored orders and coupons and never generate rewards or mutate state.

Database foreign keys, unique indexes, and check constraints enforce structural invariants. Service transactions enforce ownership, eligibility, and multi-row transitions. Arbitrary database edits are not supported application operations.

## Decision: SQLite with synchronous immediate transactions

**Context:** Different carts, retries, and coupons can compete across HTTP requests and application processes.

**Options considered:** In-memory maps with an application mutex; SQLite transactions; PostgreSQL with row locks.

**Choice:** Drizzle over better-sqlite3, foreign keys, WAL for file databases, a five-second busy timeout, and `BEGIN IMMEDIATE` for multi-step writes such as checkout, cart edits, product updates, seed, and coupon recovery. Customer creation is a single atomic INSERT. Repository reads and service writes use the same active transaction. Transactions contain no `await` or external calls.

**Why:** SQLite provides durable atomicity and coordinates independent local processes. Acquiring the writer lock before reading avoids making decisions from an outdated snapshot before upgrading to a writer. Conditional inventory decrements and coupon redemption provide explicit checks in addition to serialization.

**Consequences:** Concurrent writers serialize, and synchronous database calls block each process's event loop. This is proportionate to the assignment's workload, not a high-throughput architecture. Lock exhaustion returns retryable `503`, rather than being misreported as inventory failure. Tests run competing HTTP servers in separate processes with a controlled writer-lock barrier.

## Decision: Transactional successful checkout replay

**Context:** A client can lose the response after a checkout committed, or issue overlapping retries.

**Options considered:** Unique cart ID alone; ephemeral key cache; durable successful response in the checkout transaction; persist all failed attempts too.

**Choice:** Require a customer-scoped idempotency key. Store a canonical fingerprint of cart ID and optional coupon, the order ID, and the complete response in the same transaction as purchase. Look up replay before checking whether the cart is still open.

**Why:** A cart uniqueness constraint prevents duplicate purchases but cannot by itself reproduce the original response. Durable replay also preserves the original automatically earned coupon representation after that coupon is subsequently redeemed.

**Consequences:** Identical success returns the original `201` and a replay header. Changed inputs conflict. Failed attempts leave no key and can be corrected/retried. Records are retained indefinitely for this version. Fingerprints exclude changing cart contents because a successful replay must remain tied to the original purchase. Customer/cart creation do not implement idempotency.

Checkout first loads the cart to establish the trusted customer scope, then checks the key before validating open/nonempty state. It validates live items and coupon ownership, calculates bounded totals, conditionally decrements stock, inserts the order and item snapshots, and conditionally redeems the coupon. Order insertion precedes redemption because `redeemedOrderId` is a foreign key. It then closes the cart, issues any reward, stores the successful response, and commits before HTTP delivery. Any exception rolls back all effects. There is no separately updated counter: `latestOrderOrdinal + 1` is computed under the writer lock.

Replay uses `Idempotency-Replayed: true`. On a timeout or `503 DATABASE_BUSY` with `Retry-After: 1`, retry the same cart/coupon/key; do not create a new purchase to recover a missing response. Reusing a key with another existing cart or coupon yields `409 IDEMPOTENCY_CONFLICT`; a new key on a completed cart yields `409 CART_ALREADY_CHECKED_OUT`.

## Decision: Decimal INR interface, integer paise storage

**Context:** Users expect prices such as INR 200.34; the brief requires no floating-point rounding errors.

**Options considered:** SQLite REAL and JavaScript Number arithmetic; decimal text storage with a decimal library; integer paise with decimal strings at the API boundary.

**Choice:** Return decimal strings such as `"200.34"`, persist integer paise, and perform intermediate multiplication and aggregation with BigInt. Money parsing never passes through floating-point arithmetic.

**Why:** Decimal strings preserve readable prices, while minor-unit storage is simple and exact. JavaScript safe integer limits are explicitly checked before storing numbers. Reports aggregate BigInt values so total revenue is not limited to a single order's bound.

**Consequences:** API clients must treat monetary strings as decimal amounts. Currency is fixed to INR, with no currency conversion, tax, or shipping. Inputs with exponent notation, negatives, or more than two fractional digits are rejected. Percentage discount is floored once on the subtotal: `floor(subtotalPaise * percent / 100)`. For 200.34 at 10%, discount is 20.03 and total is 180.31. A 100% coupon yields exactly zero.

Parsing accepts nonnegative canonical decimal strings with zero, one, or two fractional digits, including `"0"`, `"200"`, and `"200.3"`; outputs always have two digits. Leading-zero forms such as `"0200.34"`, whitespace, plus signs, and numeric JSON money values are rejected. Stored paise and per-order totals cannot exceed `Number.MAX_SAFE_INTEGER` (INR `"90071992547409.91"`). Line totals, subtotal, inventory, quantities, and ordinals are bounded before persistence. Report revenue can exceed that bound because it is formatted directly from BigInt; aggregated product quantity still has a safe-integer bound.

## Decision: Live cart prices and no reservations

**Context:** Prices or inventory may change between adding an item and checkout.

**Options considered:** Lock prices at cart addition; reserve inventory; reject changed prices until explicit confirmation; calculate from current products at checkout.

**Choice:** Cart views show live prices and current availability. Checkout revalidates all items and uses current prices. Orders store immutable purchase snapshots. Cart PUT replaces an absolute quantity, and DELETE is repeatable.

**Why:** This gives a clear rule without reservation expiry or stale price commitments. Absolute quantity updates also avoid accidental additive changes on repeated cart requests.

**Consequences:** An item successfully added is not guaranteed stock at checkout. A price change is accepted without another confirmation round. The live view of a closed cart can differ from the actual purchase; clients use its order ID for immutable details. Tests change catalog fixtures between addition, checkout, and retrieval.

## Decision: Store-wide rewards assigned to the milestone customer

**Context:** The brief does not specify coupon ownership, whether milestones count per customer, expiry, or stacking.

**Options considered:** Global bearer coupons; per-customer purchase counters; store-wide milestones with rewards assigned to the customer placing the milestone order.

**Choice:** Store-wide serialized successful order ordinal; every nth order earns one customer-specific coupon. Discounted orders count. No expiry or stacking. A coupon can only be used on a later order and snapshots its percentage.

**Why:** Store-wide counting follows the brief, and customer-specific ownership reflects the requested reward model. The next ordinal is derived from the latest committed order while holding the immediate transaction writer lock, making concurrent milestone assignment unambiguous. Failed and replayed checkouts never advance it.

**Consequences:** Under concurrent purchases, whichever commits the milestone ordinal earns the coupon; arrival order is not promised. Customers need an identity resource. Ownership is verified against the cart, but without authentication callers can claim another customer's ID; this is an explicit assignment limitation.

## Decision: Automatic issuance plus milestone-gated admin recovery

**Context:** The brief requires admin generation only for reached, unrewarded milestones. Automatic generation and an admin issuance endpoint overlap.

**Options considered:** Only admin issuance; automatic issuance with recovery; unrestricted admin promotional coupons.

**Choice:** Automatically generate a coupon in the milestone checkout transaction. The admin endpoint scans for the oldest milestone missing its coupon and generates exactly one customer-specific reward using the same eligibility rule.

**Why:** Automatic issuance was explicitly retained during planning. Unrestricted promotional generation was considered and rejected in favor of the milestone requirement.

**Consequences:** Admin generation normally returns `409 NO_ELIGIBLE_MILESTONE`; it has value for imported/legacy missing rewards rather than everyday issuance. It is deliberately not a marketing coupon feature. Recovery tests simulate missing issuance through database fixtures; the service has no coupon deletion endpoint. Concurrent admin requests cannot duplicate a reward. Recovery does not rewrite an already stored historical checkout response.

## Decision: Environment-only active policy with historical order snapshots

**Context:** Changing n can redefine which historical orders were milestones; changing x can silently change promised discounts.

**Options considered:** Immutable database settings; environment-only configuration without history; environment configuration with immutable order snapshots; centrally managed effective policy versions.

**Choice:** Validate n/x from the environment on startup; they are the sole source of active configuration. Each new order snapshots its n/x. Coupon generation and admin recovery evaluate that order's ordinal against its own n, and use its historical x. Existing coupons keep their assigned percentage. No active policy table or duplicate order counter remains.

**Why:** The user requested one active source of truth and the ability to change configuration without a database update. Historical order snapshots prevent that change from reinterpreting past eligibility or promises. Snapshot data describes a completed purchase rather than configuring future checkouts.

**Consequences:** Changes take effect after restart. All instances must receive the same configuration; mixed configurations during a rolling restart are not coordinated by the database. The global order sequence continues unchanged, with new eligibility computed as `ordinal % active n === 0`. The migration backfills existing orders from the legacy database policy before dropping it, without changing coupons or replay responses. Seeding never resets purchases, prices, or inventory.

Defaults are `REWARD_EVERY_N_ORDERS=5` and `REWARD_DISCOUNT_PERCENT=10`; startup requires a positive safe integer n and an integer x from 1 through 100. There is no reward-policy update route. For example, changing n from 5 to 3 after ordinal 5 makes the next successful order (6) a milestone; it does not start a fresh three-order counting period.

## Decision: Reporting from snapshots in a consistent read transaction

**Context:** Revenue and coupon status must reconcile while checkout continues, and reporting cannot create rewards.

**Options considered:** Cached counters updated during checkout; SQL aggregate queries; exact application aggregation from immutable rows.

**Choice:** Read orders, order items, catalog labels, and coupons within one read transaction. Sum revenue with BigInt; aggregate quantities by product. Include zero-purchase products and coupon records alongside counts.

**Why:** Deriving metrics avoids drift from separately maintained totals. BigInt accumulation avoids SQLite SUM overflow and JavaScript rounding across large combined revenues.

**Consequences:** Reporting loads rows into memory and is not paginated. This is acceptable for evaluation data; production would use bounded/reporting queries, suitable decimal aggregates, or an independently reconciled reporting store. Product labels are current catalog names, while purchase names remain in order snapshots. A test uses SQLite `total_changes()` to verify repeated report reads do not write.

## Decision: Explicit client errors and committed checkout as payment success

**Context:** Clients need to distinguish invalid input, state conflicts, bad coupons, and transient database contention.

**Options considered:** Generic error messages; detailed public internal exceptions; stable domain error codes with sanitized unexpected failures. For payment: fake asynchronous provider versus committed checkout as success.

**Choice:** Zod boundary validation and stable `{ error: { code, message, details? } }` responses. Use 400/404/409/422 as documented, retryable 503 for database locks, and logged sanitized 500 for unexpected failures. Treat a committed checkout as successful payment.

**Why:** Stable codes make retry behavior explicit. No real payment integration is required, and an asynchronous fake would obscure the transaction boundaries without addressing an actual provider.

**Consequences:** No network side effects occur inside transactions. Real payments cannot simply be added inside this transaction: they need a durable pending/payment state machine, provider idempotency, outbox/webhooks, reconciliation, and compensation. API errors expose useful domain details without leaking database internals.

Malformed JSON returns `400 INVALID_JSON`, oversized bodies return `413 BODY_TOO_LARGE` (16kb limit), and unknown routes return `404 ROUTE_NOT_FOUND`. Known domain failures are returned directly; unexpected failures are logged through the configurable logger (default `console.error`). This is not a production structured logging or monitoring system.

## Implemented and intentionally deferred

Interactive API documentation is now served locally through Swagger UI at `/docs/`. The canonical OpenAPI 3.0.3 document lives in `src/docs/openapi.json`, is copied into the build through the TypeScript JSON import, and is served at `/openapi.json`. A relative `/api` server URL allows browser requests on the current host/port without client installation or CORS setup. Specification-validation and served-asset tests protect the contract and integration; the compiled smoke test covers documentation delivery. Example resource IDs require copying real values from responses, and Swagger UI does not automatically chain requests. Local UI assets and a disabled external validator keep documentation use self-contained.

Implemented: durable SQLite persistence, committed migrations, repeatable setup/seed, customers, carts, live price/inventory validation, exact INR totals, immutable orders, durable checkout replay, atomic owned-coupon redemption, automatic milestone rewards, gated admin recovery, consistent reporting, validation/error contracts, separate-process races, rollback fault injection, compiled-service smoke evaluation, and API documentation.

Deferred: authentication/authorization, inventory reservations, payments, cancellation/refunds, frontend, centrally coordinated policy versioning, coupon expiry/stacking/promotional issuance, pagination, distributed rate limiting, structured operational metrics, idempotency retention/cleanup, backups, and production deployment. The seven development dependency advisories remain documented; runtime audit reports zero at verification. Do not expose the authentication-free admin endpoints publicly as a production service.

## Multiple instances and production scale

SQLite's locks protect separate local processes using the same database file, as tested. This is not a design for separate servers each holding their own database or an arbitrarily shared network filesystem. At production scale, move to PostgreSQL with row locks or conditional updates, unique constraints, transaction-bound queries, and explicit retry handling for serialization/deadlock failures. Lock inventory rows in deterministic product order and atomically serialize the reward ordinal. Preserve durable idempotency and coupon constraints.

Add authenticated customer identity and admin authorization. Introduce payment recovery before real charging, coordinate policy rollouts across instances, paginate lists, replace full-table reports, and add backups, operational metrics, load tests, and reconciliation jobs.

## AI use and corrections

Codex assisted with repository inspection, design discussion, implementation, tests, and documentation. The work was validated with type checking, isolated business tests, separate-process HTTP races, and a fresh-database compiled JavaScript walkthrough. No private transcripts or credentials are included.

Material redirections: the initial money plan exposed minor-unit fields; the user requested readable INR prices, so the public contract changed to decimal strings while keeping exact paise arithmetic. Unrestricted admin coupons were considered, then rejected; automatic generation and milestone-gated recovery were explicitly retained. Concurrency testing was strengthened from potentially sequential single-process requests to independent HTTP processes coordinated by a held writer lock.

A later user-directed change made environment variables the sole active policy source. Order snapshots, migration-backfill tests, and policy-change tests preserve historical eligibility and discounts without retaining an active settings table.

A concrete generated-code correction: an early read-only report test compared a nonexistent `better-sqlite3` `totalChanges` property, making the runtime comparison ineffective. Type checking exposed it. The test now queries the real SQLite `SELECT total_changes()` value before and after report requests, so writes would be detected.

## Time spent and next two hours

The recorded implementation/evaluation window from the scaffold commit at 19:40 IST through the compiled smoke verification during this review at 23:34 IST on 6 October 2026 is approximately **3 hours 54 minutes elapsed**, including follow-up requests and gaps between work. This is an observable timeline, not a measured active-work total. The previous 30-minute estimate covered only the early core implementation/environment revision and must not be presented as the total for the expanded submission. Earlier planning and human review/submission time are not fully tracked; the candidate should include those when stating final approximate time spent against the assignment's 4–6 hour timebox.

With another two hours, first spend roughly 30 minutes reviewing transaction boundaries, failure injection, and durable replay after a response is lost. Then spend 30 minutes measuring writer contention and report memory on larger data, 45 minutes adding a minimal authenticated identity/admin boundary, and 15 minutes reviewing development dependency advisories and recording remaining risks. Policy rollout coordination and a real payment state machine would be separate follow-up work.

## Verification and deliverable coverage

- `npm test`: 33 focused tests cover validation, live price/stock changes, immutable orders, exact money and bounds, durable replay/reopening, customer-scoped keys, ownership and single redemption, historical policy migration, seed stability, report reconciliation, lock errors, product administration, and OpenAPI delivery.
- Six tests use independent HTTP worker processes sharing a migrated SQLite file: product repricing versus checkout, identical keys, different keys on one cart, final-stock competition, competing coupon redemption, and competing admin recovery. A held writer lock coordinates the competing requests; this is stronger evidence than sequential calls in one event loop, but not a sustained load test.
- A test-only injected exception after inventory, order/item insertion, and coupon redemption verifies full rollback. The hook is not exposed through HTTP.
- `npm run typecheck` checks application and tests; `npm run test:smoke` builds and starts compiled JavaScript with a temporary database, repeats setup, checks documentation delivery, and executes the HTTP demo. Tests are under `src/tests/` and excluded from production compilation.
- The Postman collection passed six isolated Newman runs (228 requests) across default rewards, a 100% discount policy, and a milestone above five, with repeat runs against existing orders. Newman is optional and not part of `npm test` or the application dependency tree.
- [README.md](README.md) provides repeatable setup, migration, seed, evaluation, and run commands; [API.md](API.md), [OpenAPI](src/docs/openapi.json), Swagger UI, and [Postman](postman/README.md) document requests and execution. [ARCHITECTURE.md](ARCHITECTURE.md) contains architecture, ER, and flow diagrams.
- Local history separates scaffold, persistence, business behavior, tests, and documentation, with follow-up policy and API additions. GitHub publishing is still a submission step; no public repository publication is claimed.

## Product administration extension

Product creation and partial updates are implemented under `/api/admin/products`. Requests use decimal INR `unitPrice` and nonnegative integer stock, with generated immutable IDs. Updates preserve omitted fields and set absolute available inventory, rather than applying a delta. Immediate transactions serialize updates with checkout; a price-only update cannot overwrite a concurrent purchase's remaining stock. Live carts refresh price and availability, while orders retain immutable snapshots. Empty updates, unknown fields, malformed amounts, and missing products produce explicit client errors. Authentication remains deferred.

## Postman evaluation walkthrough

The Postman v2.1 collection supplements OpenAPI with ordered executable requests and automatic variable capture. Each run creates its own customer and stocked product, places six orders, and compares the final report against a captured baseline. Five initial orders guarantee an owned reward under the default policy; custom policies above five may leave the sixth purchase undiscounted. Expected empty-cart and admin-recovery errors are asserted explicitly. Exact report reconciliation assumes no concurrent writers or manually removed milestone coupons.

Newman verification uses isolated databases and repeat runs with default rewards, 100% discounts, and a milestone above five. Newman was installed outside the repository for verification rather than added to application dependencies. An actual correction from sandbox execution: naming the response variable `data` conflicts with Postman's existing global; scripts now use `payload`.
