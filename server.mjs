/**
 * Production HTTP server. Replaces `react-router-serve` (gc-t7o2, ported from
 * FraudPilot ft-g8t), whose
 * hardcoded morgan("tiny") logged every full request URL, including the
 * Shopify id_token/hmac/session query params, to the host logs. Mirrors
 * react-router-serve 7.18's setup (compression, static asset caching, the
 * React Router request handler, SIGTERM/SIGINT close) except for the
 * query-free request log.
 */
import path from "node:path";
import url from "node:url";

import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";
import morgan from "morgan";

import { REQUEST_LOG_FORMAT, registerPathToken } from "./server/request-log.mjs";

// react-router-serve defaulted this; keep a bare `npm start` in production mode
// (FraudPilot ft-edm M2).
process.env.NODE_ENV = process.env.NODE_ENV ?? "production";

const BUILD_PATH = path.resolve("build/server/index.js");
const build = await import(url.pathToFileURL(BUILD_PATH).href);
const assetsDir = build.assetsBuildDirectory;
const publicPath = build.publicPath;

const app = express();
app.disable("x-powered-by");
app.use(compression());
app.use(
  path.posix.join(publicPath, "assets"),
  express.static(path.join(assetsDir, "assets"), {
    immutable: true,
    maxAge: "1y",
  }),
);
app.use(publicPath, express.static(assetsDir));
app.use(express.static("public", { maxAge: "1h" }));

registerPathToken(morgan);
app.use(morgan(REQUEST_LOG_FORMAT));

app.all("*", createRequestHandler({ build, mode: process.env.NODE_ENV }));

const port = Number(process.env.PORT) || 3000;
const onListen = () => console.log(`[server] listening on port ${port}`);
const server = process.env.HOST
  ? app.listen(port, process.env.HOST, onListen)
  : app.listen(port, onListen);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close(console.error));
}
