"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { addressRows, ipSourceKey } from "../lib/server-addresses";
import type { ServerView } from "../lib/types";
import { Btn } from "./ui";

/** The server's main IP with where it came from, or an honest "unknown". */
export function MainIp({ server }: { server: Pick<ServerView, "publicIp" | "publicIpv6" | "ipSource"> & Partial<Pick<ServerView, "ipv6Source">> }) {
  const t = useT();
  const ip = server.publicIp ?? server.publicIpv6;
  if (!ip) {
    return (
      <span>
        {t("servers.ipUnknown")}
        <span style={{ display: "block", fontSize: 11, fontWeight: 400, color: "var(--c-tx3)" }}>{t("servers.ipUnknownHint")}</span>
      </span>
    );
  }
  const source = server.publicIp ? server.ipSource : (server.ipv6Source ?? server.ipSource);
  return (
    <span>
      {ip}
      <span style={{ display: "block", fontSize: 11, fontWeight: 400, color: "var(--c-tx3)" }}>{t(ipSourceKey(source))}</span>
    </span>
  );
}

/**
 * Every address the host reports (IPv4 and IPv6, interfaces and cloud metadata), behind "More". A public address that
 * is not the main one can be made the main one (pinned for its family) — the way to choose among several / floating IPs.
 */
export function ServerAddresses({ server }: { server: ServerView }) {
  const t = useT();
  const qc = useQueryClient();
  const rows = addressRows(server);
  const pin = useMutation({
    mutationFn: (ip: string) => api.setServerNetwork(server.id, ip.includes(":") ? { publicIpv6: ip } : { publicIp: ip }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["server", server.id] }),
  });
  if (rows.length === 0) return null;
  return (
    <details style={{ margin: "-8px 0 20px", fontSize: 13 }}>
      <summary style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center", color: "var(--c-tx2)" }}>
        {t("servers.allIps", { n: rows.length })}
      </summary>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
        {rows.map((r) => (
          <li
            key={r.ip}
            style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "6px 0", borderTop: "1px solid var(--c-bd)", minHeight: 44 }}
          >
            <code className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>{r.ip}</code>
            <span style={{ fontSize: 11, color: "var(--c-tx3)" }}>
              {t(r.family === 6 ? "servers.ipv6" : "servers.ipv4")} · {t(r.kind === "public" ? "servers.ipPublic" : "servers.ipPrivate")}
              {r.main && r.source ? ` · ${t(ipSourceKey(r.source))}` : ""}
            </span>
            {r.main ? (
              <span style={{ fontSize: 11, color: "var(--c-g)" }}>{t("servers.ipMain")}</span>
            ) : (
              server.canWrite &&
              r.kind === "public" && (
                <Btn
                  variant="ghost"
                  style={{ minHeight: 44 }}
                  onClick={() => pin.mutate(r.ip)}
                  loading={pin.isPending && pin.variables === r.ip}
                  disabled={pin.isPending}
                >
                  {t("servers.ipUseAsMain")}
                </Btn>
              )
            )}
          </li>
        ))}
      </ul>
      {pin.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12 }}>{pin.error instanceof Error ? pin.error.message : t("servers.ipPinFailed")}</div>}
    </details>
  );
}
