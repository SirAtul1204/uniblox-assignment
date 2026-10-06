# Express + TypeScript + SQLite

Requires Node.js 22.12+ and npm. All TypeScript source and database tooling configuration live in `src/`. JavaScript output goes to `dist/`.

## Getting started

```sh
npm install
```

Optionally copy `.env.example` to `.env` and change the port or database path. Defaults work without an `.env` file.

```sh
npm run dev
```

Nodemon restarts the server when source changes; tsx executes TypeScript during development. Run `npm run typecheck` separately to check types.

```sh
npm run typecheck
npm run build
npm start
```

`npm start` runs compiled JavaScript only. `npm run build:start` compiles and starts in one command. The health endpoint is `GET http://localhost:3000/api/health`; it checks SQLite connectivity.

## Structure

```text
src/
  app.ts            Express app and middleware
  server.ts         HTTP server and shutdown
  config/           Environment configuration
  routes/           Route definitions
  controllers/      Request/response handling
  services/         Business logic
  repositories/     Database queries
  db/               SQLite connection, Drizzle schema and config
  middlewares/      Shared Express middleware
  types/            Shared TypeScript types
  utils/            Helpers
dist/               Generated JavaScript (ignored by Git)
data/               Local SQLite database (ignored by Git)
migrations/         Generated SQL migrations (commit these)
```

## Database

Drizzle ORM provides typed SQLite queries using the `better-sqlite3` driver. The database file is created automatically on server startup, with foreign keys and WAL enabled. The schema starts empty so you can define the assignment's actual entities in `src/db/schema.ts`.

After defining tables:

```sh
npm run db:generate
npm run db:migrate
```

Generate and commit migrations whenever the schema changes, and apply them before starting the application. Migrations are not applied automatically at startup. For a custom database location, create its parent directory before running migrations on a fresh deployment. `npm run db:studio` opens the database browser.

## Dependency audit

The initial installation reported seven development-tool advisories in Nodemon and Drizzle Kit dependency chains. npm's suggested fixes downgrade these tools to older incompatible versions, so they have not been applied. Review `npm audit` as upstream releases become available.
