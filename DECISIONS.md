# Design Decisions

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

**Choice:** Drizzle over better-sqlite3, foreign keys, WAL, a five-second busy timeout, and `BEGIN IMMEDIATE` for write operations. Repository reads and service writes use the same active transaction. Transactions contain no `await` or external calls.

**Why:** SQLite provides durable atomicity and coordinates independent local processes. Acquiring the writer lock before reading avoids making decisions from an outdated snapshot before upgrading to a writer. Conditional inventory decrements and coupon redemption provide explicit checks in addition to serialization.

**Consequences:** Concurrent writers serialize, and synchronous database calls block each process's event loop. This is proportionate to the assignment's workload, not a high-throughput architecture. Lock exhaustion returns retryable `503`, rather than being misreported as inventory failure. Tests run competing HTTP servers in separate processes with a controlled writer-lock barrier.

## Decision: Transactional successful checkout replay

**Context:** A client can lose the response after a checkout committed, or issue overlapping retries.

**Options considered:** Unique cart ID alone; ephemeral key cache; durable successful response in the checkout transaction; persist all failed attempts too.

**Choice:** Require a customer-scoped idempotency key. Store a canonical fingerprint of cart ID and optional coupon, the order ID, and the complete response in the same transaction as purchase. Look up replay before checking whether the cart is still open.

**Why:** A cart uniqueness constraint prevents duplicate purchases but cannot by itself reproduce the original response. Durable replay also preserves the original automatically earned coupon representation after that coupon is subsequently redeemed.

**Consequences:** Identical success returns the original `201` and a replay header. Changed inputs conflict. Failed attempts leave no key and can be corrected/retried. Records are retained indefinitely for this version. Fingerprints exclude changing cart contents because a successful replay must remain tied to the original purchase. Customer/cart creation do not implement idempotency.

## Decision: Decimal INR interface, integer paise storage

**Context:** Users expect prices such as INR 200.34; the brief requires no floating-point rounding errors.

**Options considered:** SQLite REAL and JavaScript Number arithmetic; decimal text storage with a decimal library; integer paise with decimal strings at the API boundary.

**Choice:** Return decimal strings such as `"200.34"`, persist integer paise, and perform intermediate multiplication and aggregation with BigInt. Money parsing never passes through floating-point arithmetic.

**Why:** Decimal strings preserve readable prices, while minor-unit storage is simple and exact. JavaScript safe integer limits are explicitly checked before storing numbers. Reports aggregate BigInt values so total revenue is not limited to a single order's bound.

**Consequences:** API clients must treat monetary strings as decimal amounts. Currency is fixed to INR, with no currency conversion, tax, or shipping. Inputs with exponent notation, negatives, or more than two fractional digits are rejected. Percentage discount is floored once on the subtotal: `floor(subtotalPaise * percent / 100)`. For 200.34 at 10%, discount is 20.03 and total is 180.31. A 100% coupon yields exactly zero.

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

Approximate AI-assisted implementation and verification time: 30 minutes, including the environment-policy revision and excluding earlier setup/planning and subsequent human review. Add actual human review and submission time before sending the assignment.

With another two hours, first review the transaction and replay paths against the tests, then add authenticated identity/admin guards, investigate compatible fixes for development dependency advisories, and measure SQLite contention and report memory usage. Next prioritize coordinated policy rollouts and a payment state machine only if those capabilities become required.

## Product administration extension

Product creation and partial updates are implemented under `/api/admin/products`. Requests use decimal INR `unitPrice` and nonnegative integer stock, with generated immutable IDs. Updates preserve omitted fields and set absolute available inventory, rather than applying a delta. Immediate transactions serialize updates with checkout; a price-only update cannot overwrite a concurrent purchase's remaining stock. Live carts refresh price and availability, while orders retain immutable snapshots. Empty updates, unknown fields, malformed amounts, and missing products produce explicit client errors. Authentication remains deferred.
