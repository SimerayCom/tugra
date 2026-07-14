import type { PortMapping } from "../applications/port-allocator.service";
import type { ConfigMount, ExposePort } from "./template-manifest";

/**
 * Rewrite a template's BAKED published host ports to freshly allocated ones at install time, so
 * installing the same template twice never collides on a host port. The importer bakes one port per
 * exposure as `- "<host>:<container>"` and reuses the same host number in self-referential env values
 * (`localhost:<host>`), so both are rewritten to keep the app's own URLs consistent. Pure string
 * surgery — the host port number never substring-collides (importer guarantees one exposure + one
 * ports line per template). The `localhost` HOST is intentionally left as-is; a later slice swaps it
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
