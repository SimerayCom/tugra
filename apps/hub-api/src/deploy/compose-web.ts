/**
 * Best-effort discovery of a compose stack's primary web service — the service to
 * attach a Traefik router + magic domain to. Line/indentation based (no YAML dep):
 * the FIRST top-level service (under `services:`) that publishes a port wins, and
 * its container port is the right-hand side of that first `host:container` mapping.
 * Only list items directly under a service's `ports:` key count (so `expose:`,
 * `depends_on:`, `volumes:` never masquerade as ports). Returns null when nothing
 * is unambiguously web-facing, so a magic domain is never pointed at the wrong
 * service. A curated template can override this with an explicit `web` catalog meta.
 */
export function inferComposeWeb(composeFile: string | null | undefined): { service: string; port: number } | null {
  if (!composeFile) return null;
  const lines = composeFile.split("\n");

  let i = 0;
  for (; i < lines.length; i++) {
    if (/^services:\s*$/.test(lines[i])) break;
  }
  if (i >= lines.length) return null;
  i++;

  let serviceIndent = -1; // indent of a service key (direct child of `services:`)
  let current: string | null = null;
  let inPorts = false; // are we inside the current service's `ports:` block?
  let portsIndent = -1; // indent of the `ports:` key

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const indent = line.length - line.replace(/^ */, "").length;

    if (indent === 0) break; // a new top-level key ends the services block

    if (serviceIndent === -1) serviceIndent = indent;

    if (indent === serviceIndent) {
      // A new service key `name:` (bare key, not a list item / inline value).
      const m = /^\s*([A-Za-z0-9._-]+):\s*$/.exec(line);
      current = m ? m[1] : null;
      inPorts = false;
      continue;
    }

    if (!current) continue;

    // Inline short form: `ports: ["8080:80", ...]` or `ports: "8080:80"`.
    const inlineM = /^\s*ports:\s*(\[.+\]|["'][^"']+["'])\s*$/.exec(line);
    if (inlineM) {
      const first = inlineM[1].replace(/^\[/, "").replace(/\]$/, "").split(",")[0];
      const port = parsePortMapping(first);
      if (port != null) return { service: current, port };
      inPorts = false;
      continue;
    }

    // A sub-key of the service, e.g. `ports:`, `environment:`, `volumes:`.
    const keyM = /^(\s*)([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (keyM) {
      inPorts = keyM[2] === "ports";
      portsIndent = keyM[1].length;
      continue;
    }

    // A list item — only meaningful while inside this service's `ports:` block.
    // `>=` because YAML block sequences often put the dash at the SAME column as
    // the `ports:` key; bare sibling keys are handled by the keyM branch above, and
    // list items never match keyM, so this can't misfire on the next sub-key.
    if (inPorts && indent >= portsIndent) {
      const itemM = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (itemM) {
        const port = parsePortMapping(itemM[1]);
        if (port != null) return { service: current, port };
      }
    }
  }
  return null;
}

/**
 * Container-side port from a compose port mapping value:
 *   "8080:80" -> 80 · "20002:5006" -> 5006 · "127.0.0.1:8080:80" -> 80 ·
 *   "5678:5678" -> 5678 · "80" -> 80 · "80/tcp" -> 80. Null when not a plain port.
 */
function parsePortMapping(raw: string): number | null {
  const cleaned = raw.trim().replace(/^["']|["']$/g, "").replace(/\/(tcp|udp)$/i, "");
  const parts = cleaned.split(":");
  const container = parts[parts.length - 1]; // last field is always the container port
  if (!/^\d+$/.test(container)) return null;
  const n = Number(container);
  return n >= 1 && n <= 65535 ? n : null;
}
