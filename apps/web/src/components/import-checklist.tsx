"use client";

import { useT } from "../i18n/provider";
import { CopyBtn } from "./copy-row";
import type { ImportChecklistItem } from "../lib/types";

/** Literal keys per checklist kind (so the static key-usage checks keep working): the kind never builds a key at runtime. */
const KEY = {
  "deploy-after-data": "import.services.checklist.deploy-after-data",
  "data-step": "import.services.checklist.data-step",
  quiesce: "import.services.checklist.quiesce",
  dns: "import.services.checklist.dns",
  tunnel: "import.services.checklist.tunnel",
  "repoint-dependents": "import.services.checklist.repoint-dependents",
  "unpinned-image": "import.services.checklist.unpinned-image",
  "not-carried": "import.services.checklist.not-carried",
  reach: "import.services.checklist.reach",
} as const;

const list = (v: string | number | string[] | undefined): string => (Array.isArray(v) ? v.join(", ") : v === undefined ? "" : String(v));

/**
 * The post-import checklist of ONE service: what is still to do before the stopped app can safely be deployed. The hub sends
 * only a kind, a severity and short params (compose keys, volume keys, hostnames, a network name and an alias), so every
 * sentence is a translation of a kind: no source text, secret or file content can reach this screen. Copy buttons carry the
 * values an operator actually pastes (DNS rows, the private network name and alias).
 */
export function ImportChecklist({ name, items }: { name: string; items: ImportChecklistItem[] }) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12, marginTop: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{t("import.services.checklist.title", { name })}</div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((it, i) => {
          const p = it.params;
          const hosts = Array.isArray(p.hosts) ? p.hosts : [];
          const ip = typeof p.targetIp === "string" ? p.targetIp : "";
          const key = it.kind === "reach" && p.manual ? "import.services.checklist.reachManual" : KEY[it.kind];
          const text = t(key, {
            name,
            volumes: list(p.volumes),
            members: list(p.members),
            hosts: list(p.hosts),
            services: list(p.services),
            network: list(p.network),
            alias: list(p.alias),
            ip: ip ? ` (${ip})` : "",
          });
          const copy =
            it.kind === "dns" && ip && hosts.length ? hosts.map((h) => `${h} → ${ip}`).join("\n") : it.kind === "reach" && typeof p.network === "string" && typeof p.alias === "string" ? `${p.network} ${p.alias}` : null;
          return (
            <li key={`${it.kind}-${i}`} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, color: it.severity === "warn" ? "var(--c-am)" : "var(--c-tx2)", wordBreak: "break-word" }}>
              <span style={{ flex: 1 }}>{text}</span>
              {copy && <CopyBtn text={copy} label={t("import.services.checklist.copy")} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
