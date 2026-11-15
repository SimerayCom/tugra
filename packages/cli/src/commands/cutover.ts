import type { Command } from "commander";
import { activeClient } from "../session";
import { printJson, printLine, printTable } from "../output";

export const CUTOVER_ACTIONS = ["init", "status", "prepare-certs", "check", "ttl", "plan", "flip", "revert", "finalize", "cancel", "fix-counterpart", "exclude", "include", "seed-certs"] as const;
type Action = (typeof CUTOVER_ACTIONS)[number];

interface Opts {
  hosts?: string;
  credential?: string;
  challenge?: string;
  probeVia?: string;
  healthPath?: string;
  ttl?: number;
  confirm?: string;
  batchSize?: number;
  interval?: number;
  stopOnFail?: boolean;
  autoRevert?: boolean;
  keepProxied?: boolean;
  acceptDataRisk?: boolean;
  acceptHttp01Gap?: boolean;
  skipTtlWait?: boolean;
  force?: boolean;
  acknowledgeDataLoss?: boolean;
  acknowledgeProxyRestart?: boolean;
  app?: string;
  direction?: string;
  server?: string;
  json?: boolean;
}

/** `a.com,b.com` -> ["a.com","b.com"] (trimmed, lowercased, blanks dropped); undefined when not given. */
export function parseHosts(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const hs = v.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return hs.length ? hs : undefined;
}

/** The request each action maps to (1:1 with the hub endpoint). Pure, so it is unit-tested without a network. */
export function buildRequest(action: Action, opId: string, o: Opts): { method: "GET" | "POST"; path: string; body?: unknown } {
  const base = `/import/operations/${encodeURIComponent(opId)}/cutover`;
  const hostnames = parseHosts(o.hosts);
  const sel = hostnames ? { hostnames } : {};
  const need = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };
  switch (action) {
    case "init":
      return { method: "POST", path: `${base}/init`, body: o.credential ? { dnsCredentialId: o.credential } : {} };
    case "status":
      return { method: "GET", path: base };
    case "prepare-certs":
      need(o.challenge === "dns01" || o.challenge === "http01", "--challenge dns01|http01 is required");
      return { method: "POST", path: `${base}/cert-prepare`, body: { ...sel, challenge: o.challenge } };
    case "check":
      return { method: "POST", path: `${base}/check`, body: { ...sel, ...(o.probeVia ? { probeVia: o.probeVia } : {}), ...(o.healthPath ? { healthPath: o.healthPath } : {}) } };
    case "ttl":
      return { method: "POST", path: `${base}/ttl`, body: { ...sel, ...(o.ttl ? { ttl: o.ttl } : {}) } };
    case "plan": {
      const q: string[] = [];
      if (hostnames) q.push(`hostnames=${encodeURIComponent(hostnames.join(","))}`);
      if (o.ttl) q.push(`targetTtl=${o.ttl}`);
      if (o.keepProxied === false) q.push("keepProxied=false");
      return { method: "GET", path: `${base}/flip-plan${q.length ? `?${q.join("&")}` : ""}` };
    }
    case "flip":
      need(o.confirm, "--confirm <planHash> is required (run `plan` first and review it)");
      return {
        method: "POST",
        path: `${base}/flip`,
        body: {
          confirmToken: o.confirm, ...sel,
          ...(o.batchSize ? { batchSize: o.batchSize } : {}), ...(o.interval ? { intervalSec: o.interval } : {}), ...(o.ttl ? { targetTtl: o.ttl } : {}),
          ...(o.stopOnFail === false ? { stopOnFail: false } : {}), ...(o.autoRevert ? { autoRevert: true } : {}), ...(o.keepProxied === false ? { keepProxied: false } : {}),
          ...(o.acceptDataRisk ? { acceptDataRisk: true } : {}), ...(o.acceptHttp01Gap ? { acceptHttp01Gap: true } : {}), ...(o.skipTtlWait ? { skipTtlWait: true } : {}),
        },
      };
    case "revert":
      need(hostnames, "--hosts is required");
      need(o.acknowledgeDataLoss, "--acknowledge-data-loss is required: a revert restores DNS but cannot restore data Tugra wrote after the flip");
      return { method: "POST", path: `${base}/revert`, body: { hostnames, ...(o.force ? { force: true } : {}), acknowledgeDataLoss: true } };
    case "finalize":
      return { method: "POST", path: `${base}/finalize`, body: sel };
    case "cancel":
      return { method: "POST", path: `${base}/cancel`, body: {} };
    case "fix-counterpart":
      need(o.app, "--app <applicationId> is required");
      need(o.direction === "root" || o.direction === "www", "--direction root|www is required");
      return { method: "POST", path: `${base}/fix-counterpart`, body: { applicationId: o.app, direction: o.direction } };
    case "exclude":
    case "include":
      need(hostnames, "--hosts is required");
      return { method: "POST", path: `${base}/exclude`, body: { hostnames, excluded: action === "exclude" } };
    case "seed-certs":
      need(o.acknowledgeProxyRestart, "--acknowledge-proxy-restart is required: the proxy restarts and ingress drops for every app on the server");
      return { method: "POST", path: `${base}/seed-certs`, body: { acknowledgeProxyRestart: true, ...(o.server ? { serverId: o.server } : {}) } };
  }
}

export function register(program: Command): void {
  const imp = program.commands.find((c) => c.name() === "import") ?? program.command("import").description("Fleet import (Coolify / Dokploy): follow-ups, object migration, cutover");
  imp
    .command("cutover <opId> <action>")
    .description(`SSL/DNS cutover of an imported operation: ${CUTOVER_ACTIONS.join(" | ")}`)
    .option("--hosts <a,b>", "limit to these hostnames")
    .option("--credential <id>", "init: the team Cloudflare DNS credential to use")
    .option("--challenge <dns01|http01>", "prepare-certs: certificate challenge")
    .option("--probe-via <hub|agent>", "check: where the probes run")
    .option("--health-path <path>", "check: path fetched through the target proxy")
    .option("--ttl <seconds>", "ttl/plan/flip: target TTL (60-3600)", (v) => Number(v))
    .option("--confirm <planHash>", "flip: the planHash printed by `plan`")
    .option("--batch-size <n>", "flip: hosts per batch (default 5)", (v) => Number(v))
    .option("--interval <seconds>", "flip: pause between batches (default 30)", (v) => Number(v))
    .option("--no-stop-on-fail", "flip: keep going after a failed host")
    .option("--auto-revert", "flip: revert a failed non-stateful batch entry (OFF by default)")
    .option("--no-keep-proxied", "flip: drop the Cloudflare proxy on switched records")
    .option("--accept-data-risk", "flip: allow stateful apps (their data move must be verified first)")
    .option("--accept-http01-gap", "flip: accept a TLS gap for hosts without a pre-issued certificate")
    .option("--skip-ttl-wait", "flip: do not wait for the old TTL to expire")
    .option("--force", "revert: restore even when a record changed since the flip")
    .option("--acknowledge-data-loss", "revert: acknowledge that data written on Tugra after the flip is not restored")
    .option("--acknowledge-proxy-restart", "seed-certs: acknowledge the proxy restart")
    .option("--app <id>", "fix-counterpart: application id")
    .option("--direction <root|www>", "fix-counterpart: redirect direction")
    .option("--server <id>", "seed-certs: limit to one server")
    .option("--json", "output as JSON")
    .action(async (opId: string, action: string, opts: Opts) => {
      if (!(CUTOVER_ACTIONS as readonly string[]).includes(action)) throw new Error(`unknown action ${JSON.stringify(action)} (use ${CUTOVER_ACTIONS.join(", ")})`);
      const req = buildRequest(action as Action, opId, opts);
      const res = await activeClient().client.requestRaw<Record<string, unknown>>(req.method, req.path, req.body);
      const view = (res && typeof res === "object" && "view" in res ? (res as { view: unknown }).view : res) as { entries?: Array<Record<string, unknown>> } | undefined;
      if (opts.json || !view || !Array.isArray(view.entries)) {
        if (res === undefined) printLine("ok");
        else printJson(res);
        return;
      }
      printTable(view.entries, [
        { key: "hostname", header: "HOST" },
        { key: "state", header: "STATE" },
        { key: "challenge", header: "CHALLENGE" },
        { key: "certState", header: "CERT" },
        { key: "dnsObserved", header: "DNS" },
        { key: "blockReason", header: "BLOCK" },
      ]);
    });
}
