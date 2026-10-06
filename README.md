# Reliable Checkout and Customer Rewards

Express 5 + TypeScript + Drizzle ORM + SQLite (`better-sqlite3`). Checkout atomically updates inventory, redeems a coupon, stores an immutable order, closes its cart, generates a milestone reward, and persists the replay response.

## Setup and run

Requires Node.js **22.12+** and npm. Run commands from the repository root. No private services, credentials, or external database are required.

```sh
npm ci
npm run db:setup
npm run dev
```

Optionally copy `.env.example` to `.env` before setup:

| Setting                   | Default             | Meaning                                                                |
| ------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `PORT`                    | `3000`              | HTTP port                                                              |
| `DATABASE_PATH`           | `./data/app.sqlite` | SQLite file; parent directories are created automatically              |
| `REWARD_EVERY_N_ORDERS`   | `5`                 | Positive integer: every nth successful store-wide order earns a reward |
| `REWARD_DISCOUNT_PERCENT` | `10`                | Integer percentage from 1 to 100                                       |

The environment is the sole source of the active reward policy. Change n/x in `.env` and restart the server; new orders use the new values. Each order records the policy used at checkout for historical eligibility and admin recovery, while existing coupons keep their original percentage. Changing n does not reset the store-wide order sequence: eligibility is `order ordinal % active n === 0`. All service instances must use the same environment configuration. Product seeding is idempotent and never restocks or reprices existing products. Startup requires setup and reports an actionable error if it is missing.

After upgrading from the database-policy version, run `npm run db:migrate`. The migration preserves the old policy on existing orders before dropping the settings table. Historical snapshots are purchase facts, not a second source of active configuration.

```sh
npm run typecheck
npm run build
npm start
```

`npm start` runs **compiled JavaScript** from `dist/`. `npm run build:start` builds and starts in one command. Keep the repository's `migrations/` directory alongside the compiled application when deploying.

## Evaluate

Open **[Swagger UI](http://localhost:3000/docs/)** after starting the service. Expand an endpoint and click **Try it out → Execute** to send requests directly from the browser. No Postman, account, or API-client installation is required. The UI uses the same server host and port automatically; if you change `PORT`, open `/docs/` on that port.

The UI includes a walkthrough: create a customer, copy its ID into cart creation, copy the cart ID into item and checkout requests, then retry checkout with the same key. Example customer/cart/order UUIDs are placeholders; replace them with IDs returned by your requests. The seeded Notebook product ID is ready to use. Use a new idempotency key for each new cart. To exercise rewards, place enough orders to reach the configured store-wide milestone and use the earned code on a later owned cart.

The portable **OpenAPI 3.0.3** document is available at [src/docs/openapi.json](src/docs/openapi.json) and through **[GET /openapi.json](http://localhost:3000/openapi.json)**. It can also be imported into API clients. The UI's assets are served locally, and it does not send the specification to an external validator.

While the server is running:

```sh
npm run demo
```

The demo creates a customer and cart, purchases one seeded item, repeats checkout with the same key, retrieves the order and coupons, requests admin recovery, and prints the report. It changes database state. With `n=1` on a fresh database, it also demonstrates redeeming the earned coupon on a second order. The base URL can be changed with `API_BASE_URL`.

```sh
npm test
npm run test:smoke
```

Tests use isolated temporary databases. The concurrency suite starts independent Node processes sharing the same SQLite file, holds its writer lock until both requests arrive, and then releases the competing requests. The smoke command builds the service and runs its setup and HTTP walkthrough using only compiled application JavaScript and a temporary database; an existing development server is not required.

See [API.md](API.md) for all requests, responses, statuses, and errors; see [DECISIONS.md](DECISIONS.md) for invariants, trade-offs, AI use, and deferred work.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the architecture diagram, entity relationship diagram, and customer/administrator flow diagram.

## Important behavior

- Prices are public decimal INR strings such as `"200.34"`. Internally they are integer paise, with exact BigInt arithmetic and percentage discounts rounded down once on the subtotal.
- Carts use live prices and do not reserve stock. Checkout revalidates inventory. Order snapshots remain unchanged when product data changes.
- Checkout requires `Idempotency-Key`. An identical successful retry returns the original response; a different cart or coupon with the same customer-scoped key returns `409`.
- Milestones count successful orders across the store. The customer placing the milestone order gets a single-use coupon automatically, usable only on a later order belonging to that customer.
- Admin coupon generation repairs an eligible milestone missing its coupon. Normally it returns `409 NO_ELIGIBLE_MILESTONE` because automatic issuance already generated the reward. It cannot create arbitrary promotional coupons.
- Reports are read-only and derive revenue from immutable order snapshots, not current product prices.
- Administrators can create products with `POST /api/admin/products` and partially update name, decimal `unitPrice`, or absolute `inventory` with `PATCH /api/admin/products/:productId`. Both operations are available in Swagger UI.
- Authentication is deliberately excluded. Customer IDs are trusted inputs; ownership validation is a domain rule, not an authorization boundary. Routes under `/api/admin` are administrative.

## Commands and structure

| Command                       | Purpose                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `npm run dev`                 | Nodemon + tsx; type checking is a separate command          |
| `npm run typecheck`           | Check application and test TypeScript                       |
| `npm run build` / `npm start` | Compile / run compiled server                               |
| `npm run db:setup`            | Apply committed migrations and seed products                |
| `npm run db:migrate`          | Apply committed migrations and check schema readiness       |
| `npm run db:seed`             | Seed missing products after migrations                      |
| `npm run db:generate`         | Generate migrations after changing Drizzle schema           |
| `npm run db:studio`           | Open Drizzle's database browser                             |
| `npm test`                    | Business-rule, HTTP, and separate-process concurrency tests |
| `npm run test:smoke`          | Build and evaluate compiled JavaScript in isolation         |
| `npm run demo`                | Evaluate an already running server                          |

```text
src/
  app.ts, server.ts   App factory and server lifecycle
  config/            Validated environment settings
  controllers/       HTTP contracts and Zod validation
  routes/            Route registration
  services/          Business rules and transaction boundaries
  repositories/      Reads bound to a connection or active transaction
  db/                Schema, connection factory, setup tooling, seed data
  middlewares/       Consistent error responses
  types/             Shared response types
  utils/             Exact money arithmetic and domain errors
  scripts/           Executable API walkthrough
  tests/             Isolated tests and process workers; excluded from production build
migrations/          Committed SQL and Drizzle migration metadata
dist/                Generated JavaScript; ignored by Git
data/                Local SQLite files; ignored by Git
```

## Dependency audit and submission

`npm audit --omit=dev` reports zero runtime vulnerabilities at verification. Seven development-tool advisories remain in the Nodemon/Drizzle Kit dependency chains; npm's proposed fixes downgrade those tools to incompatible older versions, so those fixes were not applied. Review upstream releases before production use.

The repository has meaningful local commits and no configured publishing destination. Before submission, review the implementation, add any human review time to the estimate in `DECISIONS.md`, and publish to your GitHub repository.
