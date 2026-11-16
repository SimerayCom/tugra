// Production entry point (`pnpm start`): the stock `next start` server plus a forwarded-header guard in front of it.
// See server/forwarded-guard.mjs for why. Everything else (routing, rewrites, streaming handlers, WebSocket upgrades
// for proxied rewrites) is Next's own request/upgrade handler, unchanged.
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import next from "next";
import { clientIpPolicyFromEnv, guardForwardedHeaders } from "./server/forwarded-guard.mjs";

const port = Number(process.env.PORT ?? 3001);
const hostname = process.env.WEB_LISTEN_HOST || undefined; // unset = all interfaces, like `next start`
const policy = clientIpPolicyFromEnv();

const app = next({ dev: false, dir: dirname(fileURLToPath(import.meta.url)), hostname: hostname ?? "0.0.0.0", port });
await app.prepare();
const handle = app.getRequestHandler();
const upgrade = app.getUpgradeHandler();

const server = http.createServer((req, res) => {
  guardForwardedHeaders(req, policy);
  void handle(req, res);
});
server.on("upgrade", (req, socket, head) => {
  guardForwardedHeaders(req, policy);
  void upgrade(req, socket, head);
});

const onListening = () => {
  console.log(
    `web ready on ${hostname ?? "0.0.0.0"}:${port} (forwarded headers: ${policy.trustProxy ? `trusted proxy${policy.strict ? ", strict" : ""}` : "socket address only"})`,
  );
};
if (hostname) server.listen(port, hostname, onListening);
else server.listen(port, onListening);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
