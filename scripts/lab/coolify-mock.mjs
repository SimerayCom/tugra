#!/usr/bin/env node
// coolify-mock.mjs --listen <port> [--bind 0.0.0.0] [--profile 4.1.2|4.7.5] [--rate-limit N] [--no-deploy-ability]
//                                                     serve the fleet-shaped Coolify API of coolify-fleet.mjs (default profile 4.1.2)
// coolify-mock.mjs --summary [--profile ...]          print each team's token, resource counts and first application as JSON, then exit
// --rate-limit N: the 4.7.5 per-user budget a minute (default 200; 0 turns the 429 off). --no-deploy-ability: POST start/stop answer 403.
// The hub's SSRF guard refuses loopback, so the lab serves it on all interfaces and points the hub at the docker host address.
import http from "node:http";
import { buildFleet, route, summary } from "./coolify-fleet.mjs";

const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const rate = val("--rate-limit", undefined);
const fleet = buildFleet({
  profile: val("--profile", "4.1.2"),
  ...(rate === undefined ? {} : { rateLimit: Number(rate) }),
  deployAbility: !args.includes("--no-deploy-ability"),
});

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
  if (r.text !== undefined) { res.writeHead(r.status, { "Content-Type": "text/plain", ...r.headers }); res.end(r.text); return; }
  res.writeHead(r.status, { "Content-Type": "application/json", ...r.headers });
  res.end(JSON.stringify(r.body));
});
server.listen(port, bind, () => console.error(`coolify-mock ${fleet.version} on ${bind}:${server.address().port}`));
