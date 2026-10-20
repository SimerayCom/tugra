import { isIP } from "node:net";
import type { PortMapping } from "../applications/port-allocator.service";
import type { ConfigMount, ExposePort } from "./template-manifest";

/**
 * Rewrite a template's BAKED published host ports to freshly allocated ones at install time, so
 * installing the same template twice never collides on a host port. The importer bakes one port per
 * exposure as `- "<host>:<container>"` and reuses the same host number in self-referential env values
 * (`localhost:<host>`), so both are rewritten to keep the app's own URLs consistent. Pure string
 * surgery — the host port number never substring-collides (importer guarantees one exposure + one
 * ports line per template). The `localhost` HOST is intentionally left as-is; it is not swapped yet
 * for the real server IP / magic domain. Returns the rewritten compose + the portMappings to persist.
 * When `mounts` are given, the same `localhost:<oldHost>` → `localhost:<newHost>` rewrite is applied to
 * each config-file body (a mount may reference the app's own baked port); returned rewritten.
 */
export function rewriteHostPorts(
  compose: string,
  exposures: ExposePort[],
  allocated: number[],
  mounts?: ConfigMount[],
): { compose: string; portMappings: PortMapping[]; mounts?: ConfigMount[] } {
  let text = compose;
  const contents = mounts ? mounts.map((m) => m.content) : null;
  const portMappings: PortMapping[] = [];
  exposures.forEach((e, i) => {
    const newHost = allocated[i];
    if (newHost == null) return;
    // Find the single baked `"<host>:<containerPort>"`; the trailing quote anchors the container port
    // (so containerPort 80 never matches an `:8080"` line).
    const m = text.match(new RegExp(`"(\\d+):${e.containerPort}"`));
    if (!m) return; // no baked published port for this exposure (defensive — shouldn't happen)
    const oldHost = m[1];
    text = text.split(`"${oldHost}:${e.containerPort}"`).join(`"${newHost}:${e.containerPort}"`);
    // Boundary lookahead so 20084 does not corrupt a `localhost:200849`.
    const localhostRe = new RegExp(`localhost:${oldHost}(?!\\d)`, "g");
    text = text.replace(localhostRe, `localhost:${newHost}`);
    if (contents) {
      for (let j = 0; j < contents.length; j++) {
        contents[j] = contents[j].replace(localhostRe, `localhost:${newHost}`);
      }
    }
    portMappings.push({
      serviceName: e.serviceName,
      containerPort: e.containerPort,
      hostPort: newHost,
      mode: e.defaultMode === "hostPort" ? "hostPort" : "domain",
    });
  });
  return {
    compose: text,
    portMappings,
    ...(mounts ? { mounts: mounts.map((m, j) => ({ ...m, content: contents![j] })) } : {}),
  };
}

/** The real reachable address a self-URL should point at. */
export interface UrlTarget {
  domain: string | null; // the app's magic/custom domain (expose.domain)
  https: boolean; // expose.https — scheme for a domain-mode URL
  serverIp: string | null; // server.publicIp ?? publicIpv6 ?? null
  web?: { service: string; port: number } | null; // the primary service the domain routes to (composeWeb)
}

/**
 * Swap the importer's baked `http://localhost:<hostPort>` / `localhost:<hostPort>` self-URLs for the
 * app's REAL reachable address. The importer bakes SERVICE_URL / SERVICE_FQDN tokens as localhost
 * (import-transform `urlLiteral`) and `rewriteHostPorts` only renumbers the port — this swaps the HOST.
 * Keyed on the ALLOCATED host port, so an internal `localhost:<containerPort>` healthcheck and the
 * published `"<hostPort>:<containerPort>"` ports line are never touched.
 *
 * Per exposure (via `portMappings`):
 *  - the PRIMARY service (composeWeb match) in `domain` mode WITH a real domain → the magic/custom
 *    domain via Traefik, PORT DROPPED: `http://localhost:<hp>` → `<scheme>://<domain>`, `localhost:<hp>` → `<domain>`.
 *  - otherwise, WITH a server IP → `serverIp:hostPort` (port KEPT, IPv6 bracketed).
 *  - with neither → left as localhost (best-effort; no fabricated public URL — SSRF-safe).
 * Applies to the compose AND each mount body. Idempotent: after one pass no `localhost:<hp>` remains.
 */
export function substituteSelfUrls(
  compose: string,
  portMappings: PortMapping[],
  target: UrlTarget,
  mounts?: ConfigMount[],
): { compose: string; mounts?: ConfigMount[] } {
  const contents = mounts ? mounts.map((m) => m.content) : null;
  let text = compose;
  // The serverIp is baked verbatim into the compose (which is later run WITHOUT re-running
  // assertSafeCompose) — a malformed value could inject a YAML line. Only bake a well-formed IP
  // literal; `isIP` returns 0 for anything else. (4 = IPv4, 6 = IPv6.)
  const ipFam = target.serverIp ? isIP(target.serverIp) : 0;

  for (const pm of portMappings) {
    const isPrimary =
      !!target.web && pm.serviceName === target.web.service && pm.containerPort === target.web.port;
    let host: string; // replacement host (with :port for hostPort mode, bare for domain mode)
    let scheme: string; // scheme used for the url-form (http://…) replacement
    if (target.domain && pm.mode === "domain" && isPrimary) {
      host = target.domain; // no port — Traefik terminates on 80/443
      scheme = target.https ? "https" : "http";
    } else if (ipFam !== 0) {
      const ipHost = ipFam === 6 ? `[${target.serverIp}]` : target.serverIp!;
      host = `${ipHost}:${pm.hostPort}`; // keep the published port
      scheme = "http";
    } else {
      continue; // no real (well-formed) address for this exposure → leave localhost
    }
    // url form first (consumes `http://localhost:<hp>`), then the remaining bare fqdn form. `(?!\d)`
    // so 20055 never eats 200559; `(?<!/)` on the fqdn pass so a stray scheme-prefixed host is skipped.
    const urlFrom = new RegExp(`http://localhost:${pm.hostPort}(?!\\d)`, "g");
    const fqdnFrom = new RegExp(`(?<!/)localhost:${pm.hostPort}(?!\\d)`, "g");
    const swap = (s: string) => s.replace(urlFrom, `${scheme}://${host}`).replace(fqdnFrom, host);
    text = swap(text);
    if (contents) for (let j = 0; j < contents.length; j++) contents[j] = swap(contents[j]);
  }

  return {
    compose: text,
    ...(mounts ? { mounts: mounts.map((m, j) => ({ ...m, content: contents![j] })) } : {}),
  };
}
