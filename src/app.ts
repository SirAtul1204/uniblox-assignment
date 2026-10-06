import express from "express";
import { createErrorHandler } from "./middlewares/error-handler";
import { createRouter } from "./routes";
import type { DatabaseContext, RewardPolicy } from "./db";
import type { StoreHooks } from "./services/store";

export function createApp(
  context: DatabaseContext,
  options: {
    rewardPolicy?: RewardPolicy;
    hooks?: StoreHooks;
    log?: (error: unknown) => void;
  } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.use("/api", createRouter(context, options.rewardPolicy, options.hooks));
  app.use((_req, res) => {
    res
      .status(404)
      .json({ error: { code: "ROUTE_NOT_FOUND", message: "Route not found" } });
  });
  app.use(createErrorHandler(options.log));
  return app;
}
