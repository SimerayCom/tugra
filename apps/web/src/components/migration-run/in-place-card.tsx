"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Boxes, CheckCircle2, Database, Globe, Loader, Undo2 } from "lucide-react";
import type { RunInPlaceView, TakeoverItemView, TakeoverStatus } from "@tugra/shared";
import { api, appFaviconUrl } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Badge, SectionCard } from "../ui";
import { ResourceIcon } from "../resource-icon";
import { formatBytes } from "../../lib/import";
import { APP_STATE_KEY, OUTCOME_KEY, appStateOf, appStateTone, domainEvidence, inPlaceBusy, itemIconHints, outcomeOf, rowsOf, type AppState, type DomainAnswer } from "../../lib/inplace-run";
import type { MigrationRunView } from "../../lib/types";

const POLL_MS = 5000;
/** More apps than this fold behind "Show all N" so a big server does not make a long page. */
const FOLDED_ROWS = 6;

/**
 * The takeover an in-place run carries. Asked for only when the run is in place; null until the run planned one. It keeps asking while the
 * takeover moves on its own (the test, the switch, the new certificates) and rests once it settles.
 */
export function useRunInPlace(run: Pick<MigrationRunView, "id" | "inPlace">) {
  return useQuery<RunInPlaceView | null>({
    queryKey: ["run-inplace", run.id],
    queryFn: () => api.getRunInPlace(run.id),
    enabled: run.inPlace,
    retry: false,
    refetchInterval: (q) => (inPlaceBusy((q.state.data as RunInPlaceView | null | undefined)?.status) ? POLL_MS : false),
  });
}

const STATE_COLOR = { ok: "var(--c-g)", warn: "var(--c-a)", danger: "var(--c-r)", muted: "var(--c-tx3)" } as const;

function StateMark({ state }: { state: AppState }) {
  const tone = appStateTone(state);
  const common = { size: 15, color: STATE_COLOR[tone], "aria-hidden": true as const, style: { flexShrink: 0 } };
  if (state === "needs_look") return <AlertTriangle {...common} />;
  if (state === "given_back") return <Undo2 {...common} />;
  if (tone === "ok") return <CheckCircle2 {...common} />;
  if (tone === "warn") return <Loader {...common} />;
  return null;
}

/** What each side answered, side by side, so the owner sees the difference instead of being told there is one. */
function Evidence({ coolify, tugra }: { coolify: DomainAnswer; tugra: DomainAnswer }) {
  const t = useT();
  const side = (name: string, a: DomainAnswer) => (
    <div style={{ minWidth: 0, flex: "1 1 160px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{name}</div>
      <div className="mono" style={{ fontSize: 12, lineHeight: 1.6, wordBreak: "break-all" }}>
        {a.status !== null && <div>{t("inPlaceRun.evidence.status", { status: a.status })}</div>}
        {a.bytes !== null && <div>{t("inPlaceRun.evidence.bytes", { size: formatBytes(a.bytes) })}</div>}
        {a.location && <div>{t("inPlaceRun.evidence.redirect", { location: a.location })}</div>}
      </div>
    </div>
  );
  return (
    <div data-testid="in-place-evidence" role="group" aria-label={t("inPlaceRun.evidence.title")} style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 4 }}>
      {side(t("inPlaceRun.evidence.coolify"), coolify)}
      {side(t("inPlaceRun.evidence.tugra"), tugra)}
    </div>
  );
}

function AppRow({ item, takeover }: { item: TakeoverItemView; takeover: TakeoverStatus }) {
  const t = useT();
  const state = appStateOf(item, takeover);
  const outcome = outcomeOf(item);
  const hints = itemIconHints(item);
  const first = item.domains[0]?.host ?? "";
  const Fallback = item.kind === "database" ? Database : item.kind === "service" ? Boxes : Globe;
  // a rebuild (or a rebuild that could not be done) is the one thing worth saying besides the state; the image-reuse default is not
  const detail = item.buildMode === "rebuild-verify" || item.rebuildDeclined ? t(OUTCOME_KEY[outcome]) : null;
  const tone = appStateTone(state);
  return (
    <li data-testid="in-place-app" data-outcome={outcome} data-state={state} style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, display: "flex", gap: 10, alignItems: "flex-start", minWidth: 0 }}>
      <span style={{ paddingTop: 1, flexShrink: 0 }}>
        <ResourceIcon
          faviconUrl={hints.appId && first ? appFaviconUrl(hints.appId, first) : null}
          image={hints.image}
          name={item.name}
          size={28}
          fallback={<Fallback size={28} color="var(--c-tx3)" aria-hidden />}
        />
      </span>
      <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <strong style={{ fontSize: 14, overflowWrap: "anywhere", flex: "1 1 140px", minWidth: 0 }}>{item.name}</strong>
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12, fontWeight: 600, color: STATE_COLOR[tone] }}>
            <StateMark state={state} />
            {t(APP_STATE_KEY[state])}
          </span>
        </div>
        {item.kind !== "database" && item.kind !== "service" && item.domains.length > 0 && (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 2 }}>
            {item.domains.map((d) => {
              const ev = d.tempCheck === "failed" ? domainEvidence(d) : null;
              return (
                <li key={d.host} style={{ minWidth: 0 }}>
                  <span className="mono" style={{ fontSize: 12, color: d.tempCheck === "failed" ? "var(--c-r)" : "var(--c-tx2)", overflowWrap: "anywhere" }}>{d.host}</span>
                  {ev && <Evidence coolify={ev.coolify} tugra={ev.tugra} />}
                </li>
              );
            })}
          </ul>
        )}
        {item.issues?.map((c) => (
          <p key={c} role="note" style={{ margin: 0, fontSize: 12, color: "var(--c-am)", lineHeight: 1.5 }}>{t(`coolifyInPlace.issue.${c}`)}</p>
        ))}
        {detail && <span style={{ fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{detail}</span>}
      </div>
    </li>
  );
}

/**
 * The body of an in-place run page: one row per app with its icon, its domains and one phrase for where it stands ("Same as Coolify",
 * "Checking...", "Needs a look", then "Live on Tugra, certificate issued"). Words next to every mark, never colour alone. Folds past a few rows.
 */
export function InPlaceCard({ run, state }: { run: MigrationRunView; state: ReturnType<typeof useRunInPlace> }) {
  const t = useT();
  const [all, setAll] = useState(false);
  if (!run.inPlace) return null;
  const view = state.data ?? null;
  const rows = view ? rowsOf(view) : [];
  const shown = all ? rows : rows.slice(0, FOLDED_ROWS);
  return (
    <SectionCard title={t("inPlaceRun.appsTitle")} right={view && view.status === "FAILED" ? <Badge tone="danger">{t(`coolifyInPlace.status.${view.status}`)}</Badge> : null} style={{ marginBottom: 0 }}>
      {state.isLoading && <p role="status" style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{t("inPlaceRun.loading")}</p>}
      {state.isError && <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--c-r)" }}>{t("inPlaceRun.unreadable")}</p>}
      {!state.isLoading && !state.isError && (!view || rows.length === 0) && <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("inPlaceRun.appsEmpty")}</p>}
      {view && rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {view.failureCode && <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--c-r)", lineHeight: 1.5 }}>{t(`coolifyInPlace.failure.${view.failureCode}`)}</p>}
          <ul aria-label={t("inPlaceRun.appsTitle")} style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
            {shown.map(({ item }) => (
              <AppRow key={item.itemRef} item={item} takeover={view.status} />
            ))}
          </ul>
          {rows.length > FOLDED_ROWS && (
            <button type="button" onClick={() => setAll((v) => !v)} className="tg-link" style={{ alignSelf: "flex-start", minHeight: 44, padding: 0, background: "transparent", border: "none", font: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              {all ? t("inPlaceRun.less") : t("inPlaceRun.more", { count: rows.length })}
            </button>
          )}
        </div>
      )}
    </SectionCard>
  );
}
