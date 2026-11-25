"use client";

import { useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { relativeTime } from "../lib/fleet";
import type { ExposedService, ScanContainer, ScanReport, ScanSite, ScanSoftware } from "../lib/types";
import { useT } from "../i18n/provider";
import { TemplateLogo } from "../lib/template-icons";
import { TriangleAlert } from "lucide-react";
import { useAuth } from "../lib/auth";
import { Pm2MovePanel } from "./pm2-move-panel";
import { Badge, Btn, SectionCard } from "./ui";

export const scanQueryKey = (serverId: string) => ["server-scan", serverId] as const;

/** Map a failed scan call to its i18n key suffix (403 = capability/permission, 503 = agent unreachable). */
export function scanErrorKey(e: unknown): "errForbidden" | "errUnavailable" | "errGeneric" {
  if (e instanceof ApiError) {
    if (e.status === 403) return "errForbidden";
    if (e.status === 503) return "errUnavailable";
  }
  return "errGeneric";
}

const noteStyle = (color = "var(--c-tx3)"): CSSProperties => ({ margin: "8px 0 0", fontSize: 12.5, color });
const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: "4px 10px", flexWrap: "wrap", padding: "7px 0", borderTop: "1px solid var(--c-bd)", fontSize: 13 };
const subHead: CSSProperties = { margin: "16px 0 4px", fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em" };
const nameStyle: CSSProperties = { fontWeight: 600, minWidth: 0, overflowWrap: "anywhere" };
const dim: CSSProperties = { color: "var(--c-tx3)", minWidth: 0, overflowWrap: "anywhere" };

/** A software logo: the vendored template logo when the scan matched one, an initials tile otherwise. Decorative (the label is next to it). */
function SoftwareIcon({ s, size = 20 }: { s: Pick<ScanSoftware, "id" | "label" | "logo">; size?: number }) {
  return (
    <span aria-hidden style={{ display: "inline-flex", flexShrink: 0 }}>
      <TemplateLogo logo={s.logo ?? undefined} slug={s.logo ?? s.id} name={s.label} size={size} monogram={!s.logo} />
    </span>
  );
}

function statusTone(state: string): "ok" | "warn" | "muted" {
  if (state === "running" || state === "online") return "ok";
  if (state === "restarting" || state === "paused") return "warn";
  return "muted";
}

const PLATFORM_LABEL = { coolify: "Coolify", dokploy: "Dokploy" } as const;

function siteKindLabel(t: ReturnType<typeof useT>, s: ScanSite): string {
  if (s.kind === "php") return s.php ? t("servers.serverScan.sitePhpVer", { v: s.php }) : t("servers.serverScan.sitePhp");
  if (s.kind === "proxy") return s.port ? t("servers.serverScan.siteProxyPort", { port: s.port }) : t("servers.serverScan.siteProxy");
  if (s.kind === "static") return t("servers.serverScan.siteStatic");
  return t("servers.serverScan.siteOther");
}

const SEVERITY_TONE = { critical: "danger", high: "warn", medium: "muted" } as const;

/**
 * The warning card at the top of a scan: public ports owned by a database, cache, queue, admin UI or the Docker API.
 * It only explains; nothing is closed from here. The fix text always names the firewall route, plus the bind route that
 * fits the owner (publish the container port on 127.0.0.1, or bind the host service to 127.0.0.1).
 */
export function ExposedServicesCard({ exposed }: { exposed: ExposedService[] }) {
  const t = useT();
  if (exposed.length === 0) return null;
  return (
    <div
      role="alert"
      data-testid="exposed-services"
      style={{ margin: "0 0 14px", padding: "12px 14px", borderRadius: "var(--r2)", border: "1px solid var(--c-r)", background: "color-mix(in srgb, var(--c-r) 8%, transparent)" }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, fontWeight: 700, fontSize: 14, color: "var(--c-r)" }}>
        <TriangleAlert size={16} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
        <span>{exposed.length === 1 ? t("servers.serverScan.exposedTitleOne") : t("servers.serverScan.exposedTitle", { n: exposed.length })}</span>
      </div>
      <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--c-tx2)" }}>{t("servers.serverScan.exposedIntro")}</p>
      <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
        {exposed.map((e) => (
          <li key={e.port} style={{ ...rowStyle, alignItems: "flex-start" }}>
            <span className="mono" style={nameStyle}>{e.port}</span>
            <span style={nameStyle}>{e.service}</span>
            <Badge tone={SEVERITY_TONE[e.severity]}>{t(`servers.serverScan.exposedSeverity.${e.severity}`)}</Badge>
            {e.container && <span className="mono" style={{ ...dim, fontSize: 12 }}>{e.container}</span>}
            {e.basis === "port" && <span style={{ ...dim, fontSize: 12 }}>{t("servers.serverScan.exposedByPort")}</span>}
            {e.basis === "account" && <span style={{ ...dim, fontSize: 12 }}>{t("servers.serverScan.exposedByAccount")}</span>}
            <span style={{ flexBasis: "100%", fontSize: 12.5, color: "var(--c-tx2)" }}>
              {t(`servers.serverScan.exposedFix.${e.fix}`, { port: e.port })} {e.fix !== "docker_api" && t("servers.serverScan.exposedFirewall")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Does a container belong to the software chip the user picked? (its own software, or the platform managing it) */
function inFilter(c: ScanContainer, id: string | null): boolean {
  return id === null || c.software === id || c.managedBy === id;
}

/**
 * "What runs on this server": a read-only scan of the host (containers and compose projects, PM2, websites, services,
 * listening ports) with a strip of software logos. It only SUGGESTS next steps (adopting containers goes through the
 * existing adopt flow); it never changes the server. The stored report is shown to any team member; scanning needs
 * server-ops (the scan starts a short-lived read-only helper container).
 */
export function ServerScanCard({
  serverId,
  canOps,
  online,
  canWrite,
  onReviewAdopt,
}: {
  serverId: string;
  canOps: boolean;
  online: boolean;
  canWrite: boolean;
  /** Take the user to the existing adopt flow. */
  onReviewAdopt: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<string | null>(null);
  const q = useQuery({ queryKey: scanQueryKey(serverId), queryFn: () => api.getServerScan(serverId) });
  const run = useMutation({
    mutationFn: () => api.runServerScan(serverId),
    onSuccess: (view) => {
      setFilter(null);
      qc.setQueryData(scanQueryKey(serverId), view);
    },
  });
  const report = q.data?.report ?? null;
  const disabledReason = !canOps ? t("servers.serverScan.needsOps") : !online ? t("servers.serverScan.offline") : undefined;

  const right = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
      {report && <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("servers.serverScan.scannedAgo", { ago: relativeTime(report.scannedAt) })}</span>}
      <Btn variant={report ? "ghost" : "primary"} loading={run.isPending} disabled={!canOps || !online} title={disabledReason} onClick={() => run.mutate()}>
        {run.isPending ? t("servers.serverScan.scanning") : report ? t("servers.serverScan.scanAgain") : t("servers.serverScan.scan")}
      </Btn>
    </span>
  );

  return (
    <SectionCard title={t("servers.serverScan.title")} right={right} style={{ marginTop: 16 }}>
      {q.isError && <p role="alert" style={noteStyle("var(--c-am)")}>{t("servers.serverScan.errGeneric")}</p>}
      {run.isError && <p role="alert" style={noteStyle("var(--c-r)")}>{t(`servers.serverScan.${scanErrorKey(run.error)}`)}</p>}
      {!report && !q.isLoading && !q.isError && (
        <p style={{ ...noteStyle(), marginTop: 0 }}>{t("servers.serverScan.intro")}</p>
      )}
      {report && (
        <ScanResult
          serverId={serverId}
          canOps={canOps}
          online={online}
          report={report}
          filter={filter}
          setFilter={setFilter}
          canWrite={canWrite}
          onReviewAdopt={onReviewAdopt}
        />
      )}
    </SectionCard>
  );
}

function ScanResult({
  serverId,
  canOps,
  online,
  report,
  filter,
  setFilter,
  canWrite,
  onReviewAdopt,
}: {
  serverId: string;
  canOps: boolean;
  online: boolean;
  report: ScanReport;
  filter: string | null;
  setFilter: (id: string | null) => void;
  canWrite: boolean;
  onReviewAdopt: () => void;
}) {
  const t = useT();
  const { user } = useAuth();
  const isOwner = !!user?.isInstanceOwner;
  const active = filter ? report.software.find((s) => s.id === filter) ?? null : null;
  const containers = report.containers.filter((c) => inFilter(c, active?.id ?? null));
  const sites = report.sites.filter((s) => !active || s.server === active.id || (active.id === "cloudpanel" && s.panel === "cloudpanel"));
  const showPm2 = report.pm2.length > 0 && (!active || active.id === "pm2");
  const showServices = !active && report.services.length > 0;
  const showPorts = !active && report.ports.length > 0;

  const adoptable = report.containers.filter((c) => c.adoptable).length;
  const managed = (["coolify", "dokploy"] as const)
    .map((p) => ({ p, n: report.containers.filter((c) => c.managedBy === p).length }))
    .filter((x) => x.n > 0);
  const hasPm2 = report.pm2.some((u) => u.procs.length > 0);
  // No fake action for CloudPanel PHP sites: they are listed below and the note says they stay where they are.
  const hasPanelPhp = report.sites.some((s) => s.panel === "cloudpanel" && s.kind === "php");
  const hasSteps = (canWrite && adoptable > 0) || managed.length > 0 || hasPm2 || hasPanelPhp;
  const nothing = report.software.length === 0 && report.containers.length === 0 && report.sites.length === 0 && !hasPm2;

  const hostNote =
    report.host.status === "ok"
      ? null
      : report.host.reason === "agent_outdated"
        ? t("servers.serverScan.hostOutdated")
        : report.host.reason === "no_image"
          ? t("servers.serverScan.hostNoImage")
          : t("servers.serverScan.hostFailed");

  return (
    <div>
      <ExposedServicesCard exposed={report.exposed ?? []} />
      {hostNote && <p role="note" style={{ ...noteStyle("var(--c-am)"), marginTop: 0 }}>{hostNote}</p>}
      {/* Without the host half there is no port list: say so, so an empty warning area never reads as "safe". */}
      {report.host.status !== "ok" && <p role="note" data-testid="exposed-unchecked" style={{ ...noteStyle("var(--c-am)"), marginTop: 0 }}>{t("servers.serverScan.exposedUnchecked")}</p>}
      {!report.docker.available && <p style={noteStyle()}>{t("servers.serverScan.noDocker")}</p>}
      {report.docker.truncated && <p style={noteStyle()}>{t("servers.serverScan.truncated", { n: report.containers.length })}</p>}
      {nothing && <p style={noteStyle()}>{t("servers.serverScan.nothing")}</p>}

      {report.software.length > 0 && (
        <ul aria-label={t("servers.serverScan.software")} style={{ listStyle: "none", margin: "4px 0 0", padding: 0, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {report.docker.tugra > 0 && (
            <li key="tugra">
              <span
                tabIndex={0}
                data-tip={t("servers.serverScan.tugraOwnHint")}
                style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: 36, padding: "4px 12px 4px 8px", borderRadius: 999, border: "1px solid var(--c-bd)", background: "var(--c-el)", color: "var(--c-tx)", fontSize: 13, fontWeight: 600 }}
              >
                <SoftwareIcon s={{ id: "tugra", label: "Tugra", logo: "tugra" }} />
                <span>Tugra</span>
                {report.docker.tugra > 1 && <span style={{ color: "var(--c-tx3)", fontWeight: 500 }}>{t("servers.serverScan.countTimes", { n: report.docker.tugra })}</span>}
              </span>
            </li>
          )}
          {report.software.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="tg-btn"
                aria-pressed={filter === s.id}
                data-tip={t(`servers.serverScan.kind.${s.kind}`)}
                onClick={() => setFilter(filter === s.id ? null : s.id)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  minHeight: 36,
                  padding: "4px 12px 4px 8px",
                  borderRadius: 999,
                  border: `1px solid ${filter === s.id ? "var(--c-a)" : "var(--c-bd)"}`,
                  background: filter === s.id ? "var(--c-ad)" : "var(--c-el)",
                  color: "var(--c-tx)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                <SoftwareIcon s={s} />
                <span>{s.label}</span>
                {s.count > 1 && <span style={{ color: "var(--c-tx3)", fontWeight: 500 }}>{t("servers.serverScan.countTimes", { n: s.count })}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {active && (
        <p style={{ ...noteStyle(), display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span>{t("servers.serverScan.filterShowing", { name: active.label })}</span>
          <Btn variant="ghost" onClick={() => setFilter(null)}>{t("servers.serverScan.filterClear")}</Btn>
        </p>
      )}

      {hasSteps && !active && (
        <>
          <h4 style={subHead}>{t("servers.serverScan.nextSteps")}</h4>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6, fontSize: 13 }}>
            {canWrite && adoptable > 0 && (
              <li style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span>{adoptable === 1 ? t("servers.serverScan.adoptHintOne") : t("servers.serverScan.adoptHint", { n: adoptable })}</span>
                <Btn variant="ghost" onClick={onReviewAdopt}>{t("servers.serverScan.adoptReview")}</Btn>
              </li>
            )}
            {managed.map(({ p, n }) => (
              <li key={p} style={{ color: "var(--c-tx2)" }}>
                {n === 1 ? t("servers.serverScan.managedHintOne", { platform: PLATFORM_LABEL[p] }) : t("servers.serverScan.managedHint", { n, platform: PLATFORM_LABEL[p] })}
              </li>
            ))}
            {hasPm2 && <li style={{ color: "var(--c-tx2)" }}>{isOwner ? t("servers.serverScan.pm2MoveHint") : t("servers.serverScan.pm2MoveHintOwnerOnly")}</li>}
            {hasPanelPhp && <li style={{ color: "var(--c-tx2)" }}>{t("servers.serverScan.phpStays")}</li>}
          </ul>
        </>
      )}

      {containers.length > 0 && (
        <>
          <h4 style={subHead}>{t("servers.serverScan.containersCount", { n: containers.length })}</h4>
          <div>
            {containers.map((c) => (
              <div key={c.name} style={rowStyle}>
                <span className="mono" style={nameStyle}>{c.name}</span>
                <span className="mono" style={{ ...dim, fontSize: 12 }}>{c.image}</span>
                <Badge tone={statusTone(c.state)}>{t(`servers.serverScan.status.${c.state}`)}</Badge>
                {c.managedBy && <Badge tone="lapis">{t("servers.serverScan.managedBy", { platform: PLATFORM_LABEL[c.managedBy] })}</Badge>}
                {c.project && <span style={{ ...dim, fontSize: 12 }}>{t("servers.serverScan.composeProject", { name: c.project })}</span>}
                {c.adoptable && canWrite && <Badge tone="gold">{t("servers.serverScan.adoptable")}</Badge>}
              </div>
            ))}
          </div>
        </>
      )}

      {showPm2 && (
        <>
          <h4 style={subHead}>{t("servers.serverScan.pm2")}</h4>
          {report.pm2.map((u) => (
            <div key={u.user} style={{ marginBottom: 8 }}>
              <div style={{ ...rowStyle, borderTop: "none", paddingBottom: 2, fontWeight: 600 }}>
                <span>{u.procs.length === 1 ? t("servers.serverScan.pm2UserOne", { user: u.user }) : t("servers.serverScan.pm2User", { user: u.user, n: u.procs.length })}</span>
                <Badge tone={u.daemon ? "ok" : "muted"}>{u.daemon ? t("servers.serverScan.pm2Daemon") : t("servers.serverScan.pm2NoDaemon")}</Badge>
              </div>
              {u.procs.map((p) => (
                <div key={p.name} style={rowStyle}>
                  <span style={nameStyle}>{p.name}</span>
                  <Badge tone={statusTone(p.status)}>{t(`servers.serverScan.status.${p.status}`)}</Badge>
                  {p.mode === "cluster" && p.instances ? <span style={{ ...dim, fontSize: 12 }}>{t("servers.serverScan.pm2Cluster", { n: p.instances })}</span> : null}
                  {p.port ? <span className="mono" style={{ ...dim, fontSize: 12 }}>:{p.port}</span> : null}
                  {p.cwd && <span className="mono" style={{ ...dim, fontSize: 12 }}>{p.cwd}</span>}
                </div>
              ))}
            </div>
          ))}
          <Pm2MovePanel serverId={serverId} online={online} canOps={canOps} />
        </>
      )}

      {sites.length > 0 && (
        <>
          <h4 style={subHead}>{t("servers.serverScan.sites")}</h4>
          <div>
            {sites.map((s) => (
              <div key={`${s.server}-${s.names[0]}`} style={rowStyle}>
                <span style={nameStyle}>{s.names[0]}</span>
                {s.names.length > 1 && <span style={{ ...dim, fontSize: 12 }}>{t("servers.serverScan.siteMore", { n: s.names.length - 1 })}</span>}
                <Badge>{siteKindLabel(t, s)}</Badge>
                {s.ssl && <Badge tone="ok">{t("servers.serverScan.siteSsl")}</Badge>}
                <span style={{ ...dim, fontSize: 12 }}>{s.panel === "cloudpanel" ? "CloudPanel" : s.server === "nginx" ? "nginx" : "Apache"}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {showServices && (
        <>
          <h4 style={subHead}>{t("servers.serverScan.services")}</h4>
          <div>
            {report.services.map((s) => (
              <div key={s.unit} style={rowStyle}>
                <span className="mono" style={nameStyle}>{s.unit}</span>
                {s.kind === "app" && <Badge tone="lapis">{t("servers.serverScan.serviceApp")}</Badge>}
                {s.running !== undefined ? (
                  <Badge tone={s.running ? "ok" : "muted"}>{s.running ? t("servers.serverScan.serviceRunning") : t("servers.serverScan.serviceStopped")}</Badge>
                ) : (
                  s.enabled && <Badge>{t("servers.serverScan.serviceEnabled")}</Badge>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {showPorts && (
        <>
          <h4 style={subHead}>{t("servers.serverScan.ports")}</h4>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {report.ports.map((p) => (
              <li key={p.port} title={p.scope === "public" ? t("servers.serverScan.portPublic") : t("servers.serverScan.portLocal")} style={{ opacity: p.scope === "public" ? 1 : 0.7 }}>
                <Badge>
                  <span className="mono">{p.port}</span>
                  {p.owner ? ` ${p.owner}` : ""}
                  <span className="sr-only"> · {p.scope === "public" ? t("servers.serverScan.portPublic") : t("servers.serverScan.portLocal")}</span>
                </Badge>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
