"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Badge, Card, Spinner } from "./ui";
import { needsExplicitTarget } from "../lib/import";
import { importServiceIcon } from "../lib/import-icon";
import { ResourceIcon } from "./resource-icon";
import type { ImportPlan, ImportRemoteKind, ImportRiskLevel, ImportServiceChoice, ImportServicePreview, ImportServiceVerdict } from "../lib/types";

type Choices = Record<string, ImportServiceChoice>;
const VERDICT_TONE: Record<ImportServiceVerdict, "ok" | "warn" | "danger"> = { importable: "ok", partial: "warn", skipped: "danger" };
const VERDICT_KEY: Record<ImportServiceVerdict, string> = { importable: "import.services.verdict.importable", partial: "import.services.verdict.partial", skipped: "import.services.verdict.skipped" };
const COMPAT_KEY = { template: "import.services.compat.template", passthrough: "import.services.compat.passthrough", blocked: "import.services.compat.blocked" } as const;
const PLANE_KEY: Record<string, string> = {
  "hub-staged": "import.services.dataplane.hubStaged",
  "manual-large": "import.services.dataplane.manualLarge",
  "not-carried": "import.services.dataplane.notCarried",
  "config-file": "import.services.dataplane.configFile",
  stateless: "import.services.dataplane.stateless",
};
/** The plan's risk code -> its translated one-liner (a literal key per code, per the spec's `risk.*` list). */
const RISK_KEY: Record<string, string> = {
  "service.compose.unavailable": "import.services.risk.compose-unavailable",
  "service.compose.unparsed": "import.services.risk.compose-unparsed",
  "service.gate": "import.services.risk.gate",
  "service.volume.name": "import.services.risk.volume-name",
  "service.member.dropped": "import.services.risk.member-dropped",
  "service.volume.hostbind": "import.services.risk.volume-hostbind",
  "service.volume.size-unknown": "import.services.risk.volume-size-unknown",
  "service.image.floating": "import.services.risk.image-floating",
  "service.files.needed": "import.services.risk.files-needed",
  "service.data.manual-large": "import.services.risk.data-manual-large",
  "service.data.not-carried": "import.services.risk.data-not-carried",
  "service.hold": "import.services.risk.hold",
  "service.deploy.manual": "import.services.risk.deploy-manual",
  "service.reach": "import.services.risk.reach",
  "service.container-name": "import.services.risk.container-name",
  "service.secrets.unverified": "import.services.risk.secrets-unverified",
  "service.type.unsupported": "import.services.risk.type-unsupported",
};
const RISK_COLOR: Record<ImportRiskLevel, string> = { blocker: "var(--c-r)", warn: "var(--c-am)", info: "var(--c-tx3)" };

/** Debounce a value (the preview re-runs only after the operator pauses typing). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/**
 * The service stacks of a Coolify import: one card per service with its verdict, members, volumes, domains, variables and
 * what is not carried, plus the choices an operator can make (rename, target server, volume data policy, domain rows, pin
 * the image, leave a member out, skip the whole service). Everything shown is a variable NAME, a compose key, a volume key,
 * a hostname or a fixed reason: the preview endpoint never returns a value or a file's content. Mobile first: cards stack
 * and every row wraps.
 */
export function ImportServicesPanel({
  sessionId,
  kind,
  plan,
  servers,
  choices,
  onChoice,
  onMissingTargets,
}: {
  sessionId: string;
  kind: ImportRemoteKind;
  plan: ImportPlan;
  servers: { id: string; name: string }[];
  choices: Choices;
  onChoice: (itemRef: string, patch: ImportServiceChoice | null) => void;
  /** Called with how many services still need an explicit target server (the apply stays disabled while > 0). */
  onMissingTargets?: (n: number) => void;
}) {
  const t = useT();
  const debounced = useDebounced(choices, 400);
  const items = plan.items.filter((i) => i.kind === "service");
  const { data, isLoading, isError } = useQuery({
    enabled: items.length > 0, // a plan without services never calls the preview endpoint
    queryKey: ["import-services-preview", sessionId, JSON.stringify(debounced)],
    queryFn: () => api.previewImportServices({ sessionId, sourceKind: kind, choices: Object.keys(debounced).length ? debounced : undefined }),
    placeholderData: (prev) => prev,
    staleTime: 0,
  });
  // The hub answers for every service of the source; only the stacks of this (scoped) plan are shown, counted, and able to hold the apply back.
  const inPlan = new Set(items.map((i) => i.itemRef));
  const cards = (data?.services ?? []).filter((c) => inPlan.has(c.itemRef));
  const missing = cards.filter((c) => needsExplicitTarget(c, choices[c.itemRef])).length;
  useEffect(() => {
    onMissingTargets?.(missing);
  }, [missing, onMissingTargets]);
  if (items.length === 0) return null;
  const count = (v: ImportServiceVerdict) => cards.filter((c) => c.verdict === v).length;

  return (
    <Card style={{ padding: 16 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>
        {t("import.services.title")} <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}>({items.length})</span>
      </div>
      <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "4px 0 10px", lineHeight: 1.5 }}>{t("import.services.desc")}</p>
      {isLoading && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
          <Spinner /> {t("import.services.loading")}
        </div>
      )}
      {isError && <div style={{ color: "var(--c-r)", fontSize: 12 }}>{t("import.services.previewFailed")}</div>}
      {cards.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 10 }}>
          {t("import.services.summary", { importable: count("importable"), partial: count("partial"), skipped: count("skipped") })}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {cards.map((card) => (
          <ServiceCard key={card.itemRef} card={card} item={items.find((i) => i.itemRef === card.itemRef)} servers={servers} choice={choices[card.itemRef]} onChoice={(patch) => onChoice(card.itemRef, patch)} />
        ))}
      </div>
    </Card>
  );
}

function ServiceCard({
  card,
  item,
  servers,
  choice,
  onChoice,
}: {
  card: ImportServicePreview;
  item: ImportPlan["items"][number] | undefined;
  servers: { id: string; name: string }[];
  choice: ImportServiceChoice | undefined;
  onChoice: (patch: ImportServiceChoice | null) => void;
}) {
  const t = useT();
  const set = (patch: ImportServiceChoice) => onChoice({ ...(choice ?? {}), ...patch });
  const skipped = card.verdict === "skipped";
  const included = !choice?.skip && !skipped;
  const target = choice?.targetServerId ?? "";
  const needsTarget = needsExplicitTarget(card, choice);
  const keptMembers = card.members.filter((m) => m.status === "kept");
  const svcIcon = importServiceIcon(card.name, card.members);
  const dropSet = new Set(choice?.dropMembers ?? []);
  const rows = choice?.serviceDomains ?? card.domains;

  const setDomains = (next: Array<{ service: string; hostname: string; port: number }>) => set({ serviceDomains: next });
  const toggleDrop = (name: string) => {
    const next = new Set(dropSet);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    set({ dropMembers: [...next].sort() });
  };
  const setVolume = (key: string, v: { policy: "copy" | "empty" | "skip"; owner?: { uid: number; gid: number } }) => set({ volumes: { ...(choice?.volumes ?? {}), [key]: v } });

  return (
    <div style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12, opacity: included ? 1 : 0.7 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <span aria-hidden style={{ width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <ResourceIcon image={svcIcon.image} brand={svcIcon.brand} name={card.name} size={20} fallback={<Layers size={14} style={{ color: "var(--c-tx3)" }} />} />
        </span>
        <span className="mono" style={{ fontWeight: 600, fontSize: 13, wordBreak: "break-all", flex: "1 1 160px" }}>{card.name}</span>
        <Badge tone={VERDICT_TONE[card.verdict]}>{t(VERDICT_KEY[card.verdict])}</Badge>
        {card.hold && <Badge tone="warn">{t("import.services.hold.label")}</Badge>}
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
          <input type="checkbox" checked={included} disabled={skipped} onChange={(e) => set({ skip: !e.target.checked })} />
          {t("import.services.include")}
        </label>
      </div>
      <div style={{ fontSize: 11, color: "var(--c-tx3)", marginBottom: 8 }}>
        {t(COMPAT_KEY[card.compat])}
        {card.sourceServer ? ` · ${t("import.services.sourceServer", { server: card.sourceServer })}` : ""}
      </div>

      {skipped && card.blockers.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{t("import.services.blockers")}</div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 11, color: "var(--c-r)" }}>
            {item?.risks
              .filter((r) => r.level === "blocker")
              .map((r) => (
                <li key={r.code}>{RISK_KEY[r.code] ? t(RISK_KEY[r.code]) : r.code}</li>
              ))}
          </ul>
        </div>
      )}
      {skipped && card.blockers.length === 0 && item && item.risks.length > 0 && (
        <ul style={{ margin: "0 0 8px", paddingLeft: 16, fontSize: 11, color: "var(--c-tx3)" }}>
          {item.risks.map((r) => (
            <li key={r.code}>{RISK_KEY[r.code] ? t(RISK_KEY[r.code]) : r.code}</li>
          ))}
        </ul>
      )}

      {!skipped && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginBottom: 10 }}>
          <div>
            <label style={lbl} htmlFor={`svc-name-${card.itemRef}`}>{t("import.services.rename")}</label>
            <input id={`svc-name-${card.itemRef}`} style={input} value={choice?.name ?? card.name} onChange={(e) => set({ name: e.target.value })} maxLength={63} autoComplete="off" spellCheck={false} />
            {card.nameClash && <div role="alert" style={{ fontSize: 11, color: "var(--c-am)", marginTop: 2 }}>{t(card.nameClash === "team" ? "import.services.nameClash.team" : "import.services.nameClash.import")}</div>}
          </div>
          <div>
            <label style={lbl} htmlFor={`svc-target-${card.itemRef}`}>{t("import.services.targetServer")}</label>
            <select id={`svc-target-${card.itemRef}`} style={input} value={target} onChange={(e) => set({ targetServerId: e.target.value || undefined })}>
              <option value="">{card.sourceServer === "localhost" ? t("import.services.targetPick") : t("import.services.targetDefault")}</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            {needsTarget && <div role="alert" style={{ fontSize: 11, color: "var(--c-am)", marginTop: 2 }}>{t("import.services.needsTarget")}</div>}
          </div>
        </div>
      )}

      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{t("import.services.members")}</div>
      <ul style={{ margin: "0 0 10px", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}>
        {card.members.map((m) => (
          <li key={m.name} style={{ fontSize: 12, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "baseline" }}>
            <span className="mono">{m.name}</span>
            <span style={{ color: m.status === "kept" && !dropSet.has(m.name) ? "var(--c-g)" : "var(--c-am)" }}>
              {m.status === "kept" && !dropSet.has(m.name) ? t("import.services.member.kept") : t("import.services.member.dropped")}
            </span>
            {m.reason && <span style={{ color: "var(--c-tx3)" }}>{m.reason}</span>}
            {m.status === "kept" && keptMembers.length > 1 && !skipped && (
              <label style={{ display: "flex", gap: 4, alignItems: "center", color: "var(--c-tx3)" }}>
                <input type="checkbox" checked={dropSet.has(m.name)} onChange={() => toggleDrop(m.name)} />
                {t("import.services.memberSkip", { name: m.name })}
              </label>
            )}
          </li>
        ))}
      </ul>

      {!skipped && (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{t("import.services.volumes")}</div>
          {card.volumes.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 10 }}>{t("import.services.noVolumes")}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
              {card.volumes.map((v) => {
                const cur = choice?.volumes?.[v.key];
                return (
                  <div key={v.key} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 12 }}>
                    <span className="mono">{v.key}</span>
                    <Badge tone={v.dataPlane === "manual-large" || v.dataPlane === "not-carried" ? "warn" : "muted"}>{PLANE_KEY[v.dataPlane] ? t(PLANE_KEY[v.dataPlane]) : v.dataPlane}</Badge>
                    {v.origin === "host-bind" && <span style={{ color: "var(--c-am)" }}>{t("import.services.volume.hostBind")}</span>}
                    {v.policy === "copy" && <span style={{ color: "var(--c-tx3)" }}>{t("import.services.volume.sizeUnknown")}</span>}
                    <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <span style={{ color: "var(--c-tx3)" }}>{t("import.services.volume.policy")}</span>
                      <select aria-label={`${v.key} ${t("import.services.volume.policy")}`} style={{ ...input, width: "auto", marginBottom: 0 }} value={v.policy} onChange={(e) => setVolume(v.key, { policy: e.target.value as "copy" | "empty" | "skip", owner: cur?.owner })}>
                        <option value="copy">{t("import.services.volume.copy")}</option>
                        <option value="empty">{t("import.services.volume.empty")}</option>
                        <option value="skip">{t("import.services.volume.skip")}</option>
                      </select>
                    </label>
                    <span style={{ display: "flex", gap: 4, alignItems: "center", color: "var(--c-tx3)" }}>
                      {t("import.services.volume.owner")}
                      <input aria-label={`${v.key} ${t("import.services.volume.uid")}`} type="number" min={0} max={65535} style={{ ...input, width: 70, marginBottom: 0 }} value={cur?.owner?.uid ?? ""} onChange={(e) => setVolume(v.key, { policy: v.policy, owner: e.target.value === "" ? undefined : { uid: Number(e.target.value), gid: cur?.owner?.gid ?? Number(e.target.value) } })} />
                      <input aria-label={`${v.key} ${t("import.services.volume.gid")}`} type="number" min={0} max={65535} style={{ ...input, width: 70, marginBottom: 0 }} value={cur?.owner?.gid ?? ""} onChange={(e) => setVolume(v.key, { policy: v.policy, owner: { uid: cur?.owner?.uid ?? 0, gid: Number(e.target.value) } })} />
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{t("import.services.domains")}</div>
          {rows.length === 0 && <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 6 }}>{t("import.services.domain.none")}</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 6 }}>
            {rows.map((r, i) => (
              <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                <select aria-label={t("import.services.domain.service")} style={{ ...input, width: "auto", marginBottom: 0 }} value={r.service} onChange={(e) => setDomains(rows.map((x, j) => (j === i ? { ...x, service: e.target.value } : x)))}>
                  {keptMembers.map((m) => (
                    <option key={m.name} value={m.name}>{m.name}</option>
                  ))}
                </select>
                <input aria-label={t("import.services.domain.hostname")} style={{ ...input, flex: "1 1 180px", marginBottom: 0 }} value={r.hostname} onChange={(e) => setDomains(rows.map((x, j) => (j === i ? { ...x, hostname: e.target.value } : x)))} inputMode="url" autoComplete="off" spellCheck={false} />
                <input aria-label={t("import.services.domain.port")} type="number" min={1} max={65535} style={{ ...input, width: 80, marginBottom: 0 }} value={r.port} onChange={(e) => setDomains(rows.map((x, j) => (j === i ? { ...x, port: Number(e.target.value) } : x)))} />
                <button type="button" onClick={() => setDomains(rows.filter((_, j) => j !== i))} style={linkBtn}>{t("import.services.domain.remove")}</button>
              </div>
            ))}
          </div>
          {keptMembers.length > 0 && (
            <button type="button" onClick={() => setDomains([...rows, { service: keptMembers[0].name, hostname: "", port: card.domainHints.find((h) => h.service === keptMembers[0].name)?.port ?? 80 }])} style={linkBtn}>
              {t("import.services.domain.add")}
            </button>
          )}

          {card.hold && (
            <p style={{ fontSize: 12, color: "var(--c-am)", margin: "10px 0 0" }}>
              <strong>{t("import.services.hold.label")}.</strong> {t("import.services.hold.why")}
            </p>
          )}

          {card.floating.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, color: "var(--c-am)", marginBottom: 4 }}>{t("import.services.image.unpinned", { services: card.floating.join(", ") })}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {card.floating.map((svc) => (
                  <label key={svc} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 12 }}>
                    <span>{t("import.services.image.pin", { service: svc })}</span>
                    <input style={{ ...input, flex: "1 1 220px", marginBottom: 0 }} placeholder={t("import.services.image.pinPlaceholder")} value={choice?.pins?.[svc] ?? ""} onChange={(e) => set({ pins: { ...(choice?.pins ?? {}), [svc]: e.target.value.trim() } })} autoComplete="off" spellCheck={false} />
                  </label>
                ))}
              </div>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, marginTop: 6, color: "var(--c-tx3)" }}>
                <input type="checkbox" checked={choice?.pinImages === false} onChange={(e) => set({ pinImages: e.target.checked ? false : undefined })} />
                {t("import.services.image.keepFloating")}
              </label>
            </div>
          )}

          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 10, display: "flex", flexDirection: "column", gap: 2 }}>
            {card.env.secretsAvailable ? (
              <span>
                {t("import.services.env.carried", { n: card.env.resolved.length })}
                {card.env.missing.length > 0 ? ` · ${t("import.services.env.missing", { n: card.env.missing.length, names: card.env.missing.join(", ") })}` : ""}
              </span>
            ) : (
              <span style={{ color: "var(--c-am)" }}>{t("import.services.env.unavailable", { names: card.env.missing.join(", ") || "-" })}</span>
            )}
            {card.files.needed.length > 0 && <span style={{ color: "var(--c-am)" }}>{t("import.services.files.needed", { list: card.files.needed.join(", ") })}</span>}
            {card.files.available.length > 0 && <span>{t("import.services.files.available", { n: card.files.available.length })}</span>}
          </div>

          {card.notCarried.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--c-tx3)" }}>{t("import.services.notCarried", { n: card.notCarried.length })}</summary>
              <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 11 }}>
                {card.notCarried.map((n, i) => (
                  <li key={`${n.field}-${i}`} style={{ color: n.level === "warn" ? "var(--c-am)" : "var(--c-tx3)", wordBreak: "break-word" }}>
                    <span className="mono" style={{ wordBreak: "break-all" }}>{n.field}</span>: {n.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {item && item.risks.length > 0 && !skipped && (
        <ul style={{ margin: "8px 0 0", paddingLeft: 16, fontSize: 11 }}>
          {item.risks.map((r) => (
            <li key={r.code} style={{ color: RISK_COLOR[r.level as ImportRiskLevel] }}>{RISK_KEY[r.code] ? t(RISK_KEY[r.code]) : r.code}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const lbl: React.CSSProperties = { display: "block", fontSize: 11, color: "var(--c-tx3)", margin: "0 0 3px" };
const input: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 12,
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontFamily: "inherit",
  marginBottom: 0,
};
const linkBtn: React.CSSProperties = { background: "none", border: "none", color: "var(--c-a)", cursor: "pointer", fontSize: 12, padding: 0, fontFamily: "inherit" };
