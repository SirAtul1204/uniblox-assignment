import express from "express";
import swaggerUi from "swagger-ui-express";
import openapiDocument from "./docs/openapi.json";
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
  app.get("/openapi.json", (_req, res) => {
    res.json(openapiDocument);
  });
  app.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(undefined, {
      customSiteTitle: "Checkout and Rewards API",
      customCss: ".swagger-ui .topbar { display: none; }",
      swaggerOptions: {
        url: "/openapi.json",
        validatorUrl: null,
        tryItOutEnabled: true,
        displayRequestDuration: true,
        docExpansion: "list",
      },
    }),
  );
  app.use("/api", createRouter(context, options.rewardPolicy, options.hooks));
  app.use((_req, res) => {
    res
      .status(404)
      .json({ error: { code: "ROUTE_NOT_FOUND", message: "Route not found" } });
  });
  app.use(createErrorHandler(options.log));
  return app;
}
