import express from "express";
import { createApp } from "../app";
import { openDatabase } from "../db";

const path = process.argv[2];
if (!path) throw new Error("Missing worker database path");
const context = openDatabase(path);
const host = express();
host.use((_req, _res, next) => {
  process.send?.({ type: "request-started" });
  next();
});
host.use(createApp(context));
const server = host.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Worker failed to bind TCP port");
  process.send?.({ type: "ready", port: address.port });
});
process.on("message", (message) => {
  if (message === "shutdown")
    server.close(() => {
      context.sqlite.close();
      process.disconnect?.();
    });
});
