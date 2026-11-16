#!/usr/bin/env node
// coolify-mock.mjs --listen <port> [--bind 0.0.0.0]    serve the fleet-shaped Coolify 4.1.2 API of coolify-fleet.mjs
// coolify-mock.mjs --summary                           print each team's token and resource counts as JSON, then exit
// The hub's SSRF guard refuses loopback, so the lab serves it on all interfaces and points the hub at the docker host address.
import http from "node:http";
import { buildFleet, route, summary } from "./coolify-fleet.mjs";

const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const fleet = buildFleet();

if (args.includes("--summary")) {
  console.log(JSON.stringify(summary(fleet)));
  process.exit(0);
}
const port = Number(val("--listen", "4010"));
const bind = val("--bind", "0.0.0.0");
const server = http.createServer((req, res) => {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
  const path = (req.url ?? "/").split("?")[0];
  const r = route(fleet, req.method ?? "GET", path, token);
  if (r.text !== undefined) { res.writeHead(r.status, { "Content-Type": "text/plain" }); res.end(r.text); return; }
  res.writeHead(r.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(r.body));
});
server.listen(port, bind, () => console.error(`coolify-mock ${fleet.version} on ${bind}:${server.address().port}`));
