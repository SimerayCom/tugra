"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TakeoverCertState, TakeoverItemView, TakeoverView } from "@tugra/shared";
import { api, ApiError } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { actionsFor, confirmMatches, dbRollup, pollMs, rebuildCandidates, rebuildOf, rollup, toggleChoice, verifyHasWork, type TakeoverAction } from "../../lib/inplace";
import { Badge, Btn, SectionCard, Spinner } from "../ui";
import { Modal } from "../modal";
import { Field, TextInput } from "../form";
import { useToast } from "../toast";

type T = ReturnType<typeof useT>;

/** A localized line for a failed call: the hub's stable code when the web knows it, else a generic one. Never the response text. */
export function takeoverErrorText(t: T, e: unknown): string {
  if (e instanceof ApiError) {
    const keys = [e.code, e.message].filter((x): x is string => !!x).map((c) => `coolifyInPlace.error.${c.replaceAll("-", "_")}`);
    for (const k of keys) {
      const text = t(k);
      if (text !== k) return text;
    }
    if (e.status === 403) return t("coolifyInPlace.error.forbidden");
  }
  return t("coolifyInPlace.error.generic");
}

const CERT_TONE: Record<TakeoverCertState, "muted" | "warn" | "ok" | "danger"> = { pending: "muted", fallback: "warn", issued: "ok", failed: "danger" };
const CHECK_TONE = { pending: "muted", ok: "ok", failed: "danger" } as const;

/**
 * Take a server over in place: plan, test (Tugra's proxy with no published port), take the ports, get new certificates, give back to Coolify.
 * Names, counts and codes only. The two steps that change the box's ports ask for the server's name to be typed. Mobile first: one column,
 * wrapping rows, 44px targets.
 */
export function TakeoverPanel({ serverId, serverName, opId }: { serverId: string; serverName: string; opId?: string }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [typed, setTyped] = useState<null | { kind: "swap" | "giveBack" }>(null);
  const [name, setName] = useState("");
  const q = useQuery({
    queryKey: ["coolify-inplace", serverId],
    queryFn: () => api.listInPlace(serverId),
    refetchInterval: (query) => pollMs(current(query.state.data ?? [])),
  });
  const view = current(q.data ?? []);
  // The owner's choice of apps to rebuild with Tugra; until something is chosen, what a planned takeover already says
  const [chosen, setChosen] = useState<string[] | null>(null);
  const selected = chosen ?? rebuildOf(view?.status === "PLANNED" ? view : null);
  // Only before anything is changed on the box: a plan changes nothing, so it can be redone with another choice
  const picking = q.isSuccess && (!view || view.status === "GIVEN_BACK" || view.status === "PLANNED");
  const op = useQuery({ queryKey: ["import-op-takeover", opId], queryFn: () => api.getImportOperation(opId ?? ""), enabled: picking && !!opId, staleTime: 60_000 });
  const candidates = rebuildCandidates(op.data);
  const done = (v: TakeoverView) => {
    qc.setQueryData<TakeoverView[]>(["coolify-inplace", serverId], (old) => [v, ...(old ?? []).filter((x) => x.id !== v.id)]);
    setTyped(null);
    setName("");
  };
  const fail = (e: unknown) => toast(takeoverErrorText(t, e), "error");
  const plan = useMutation({
    mutationFn: () => api.planInPlace({ serverId, opId: opId ?? "", ...(selected.length > 0 ? { rebuild: selected } : {}) }),
    onSuccess: (v: TakeoverView) => {
      done(v);
      setChosen(null);
    },
    onError: fail,
  });
  const test = useMutation({ mutationFn: () => api.testInPlace(view!.id), onSuccess: done, onError: fail });
  const verify = useMutation({ mutationFn: () => api.verifyInPlace(view!.id), onSuccess: done, onError: fail });
  const swap = useMutation({ mutationFn: () => api.swapInPlace(view!.id, name.trim()), onSuccess: done, onError: fail });
  const giveBack = useMutation({ mutationFn: () => api.giveBackInPlace(view!.id, name.trim()), onSuccess: done, onError: fail });
  const busy = plan.isPending || test.isPending || verify.isPending || swap.isPending || giveBack.isPending;
  // Planning needs the guided run it belongs to: without one this screen only shows and continues a takeover that exists.
  const actions = actionsFor(view).filter((a) => a !== "plan" || !!opId);
  const r = view ? rollup(view) : null;
  const dbr = view ? dbRollup(view) : null;

  const press = (a: TakeoverAction) => {
    if (a === "plan") plan.mutate();
    else if (a === "test") test.mutate();
    else if (a === "verify") verify.mutate();
    else setTyped({ kind: a });
  };
  const label = (a: TakeoverAction): string => t(`coolifyInPlace.action.${a}`);

  return (
    <SectionCard title={t("coolifyInPlace.title")} desc={t("coolifyInPlace.subtitle")} style={{ padding: 20, marginBottom: 0 }}>
      {q.isLoading && <Spinner />}
      {q.isError && <p role="alert" style={{ color: "var(--c-r)", fontSize: 13 }}>{t("coolifyInPlace.error.generic")}</p>}
      {!q.isLoading && !view && <p style={{ fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("coolifyInPlace.none", { server: serverName })}</p>}
      {!q.isLoading && !view && !opId && (
        <p data-testid="takeover-needs-run" style={{ fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5 }}>
          {t("coolifyInPlace.needsRun")} <Link href="/import">{t("coolifyInPlace.needsRunLink")}</Link>
        </p>
      )}
      {view && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Badge tone={view.status === "FAILED" ? "danger" : view.status === "VERIFIED" || view.status === "GIVEN_BACK" ? "ok" : "lapis"}>{t(`coolifyInPlace.status.${view.status}`)}</Badge>
            {view.failureCode && <span role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{t(`coolifyInPlace.failure.${view.failureCode}`)}</span>}
          </div>
          <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t(`coolifyInPlace.hint.${view.status}`)}</p>
          {r && (
            <p data-testid="takeover-rollup" style={{ margin: 0, fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>
              {t("coolifyInPlace.rollup", { apps: r.apps, skipped: r.skipped, domains: r.domains, tested: r.tested, checked: r.checked, issued: r.certs.issued })}
            </p>
          )}
          {dbr && dbr.total + dbr.skipped > 0 && (
            <p data-testid="takeover-db-rollup" style={{ margin: 0, fontSize: 12, color: "var(--c-tx2)", lineHeight: 1.5 }}>
              {t("coolifyInPlace.database.rollup", { count: dbr.total, ok: dbr.ok, skipped: dbr.skipped })}
            </p>
          )}
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {view.items.map((i) => (
              <ItemRow key={i.itemRef} item={i} t={t} />
            ))}
          </ul>
          {verifyHasWork(view) && <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)" }}>{t("coolifyInPlace.verifyAgain")}</p>}
        </div>
      )}
      {picking && candidates.length > 0 && (
        <fieldset data-testid="rebuild-picker" style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12, margin: "14px 0 0", display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <legend style={{ fontSize: 13, fontWeight: 600, padding: "0 6px" }}>{t("coolifyInPlace.rebuild.title")}</legend>
          <p style={{ margin: 0, fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5 }}>{t("coolifyInPlace.rebuild.hint")}</p>
          {candidates.map((c) => (
            <label key={c.itemRef} style={{ display: "flex", gap: 10, alignItems: "center", minHeight: 44, fontSize: 13, overflowWrap: "anywhere" }}>
              <input type="checkbox" checked={selected.includes(c.itemRef)} onChange={() => setChosen(toggleChoice(selected, c.itemRef))} disabled={busy} style={{ width: 20, height: 20, flexShrink: 0 }} />
              <span>{t("coolifyInPlace.rebuild.option", { name: c.name })}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
        {view?.status === "PLANNED" && (
          <Btn variant="ghost" onClick={() => plan.mutate()} disabled={busy} loading={plan.isPending} style={{ minHeight: 44 }}>
            {t("coolifyInPlace.action.replan")}
          </Btn>
        )}
        {actions.map((a) => (
          <Btn key={a} variant={a === "giveBack" ? "ghost" : "primary"} onClick={() => press(a)} disabled={busy} loading={busy && ((a === "plan" && plan.isPending) || (a === "test" && test.isPending) || (a === "verify" && verify.isPending))} style={{ minHeight: 44 }}>
            {label(a)}
          </Btn>
        ))}
      </div>
      {view && actions.includes("giveBack") && <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--c-tx3)" }}>{t("coolifyInPlace.giveBack.hint")}</p>}
      {typed && (
        <Modal onClose={() => !busy && setTyped(null)} ariaLabel={t(`coolifyInPlace.typed.${typed.kind}.title`)} width={460} closeOnBackdrop={false}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!confirmMatches(name, serverName) || busy) return;
              if (typed.kind === "swap") swap.mutate();
              else giveBack.mutate();
            }}
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{t(`coolifyInPlace.typed.${typed.kind}.title`)}</h2>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--c-tx2)" }}>{t(`coolifyInPlace.typed.${typed.kind}.body`)}</p>
            <Field label={t("coolifyInPlace.typed.label", { name: serverName })}>
              <TextInput value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" style={{ minHeight: 44 }} />
            </Field>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <Btn variant="ghost" onClick={() => setTyped(null)} disabled={busy}>{t("common.cancel")}</Btn>
              <Btn type="submit" disabled={!confirmMatches(name, serverName) || busy} loading={swap.isPending || giveBack.isPending}>
                {t(`coolifyInPlace.typed.${typed.kind}.confirm`)}
              </Btn>
            </div>
          </form>
        </Modal>
      )}
    </SectionCard>
  );
}

/** The takeover the screen is about: a live one, else the latest. */
function current(list: TakeoverView[]): TakeoverView | null {
  return list.find((v) => v.status !== "GIVEN_BACK") ?? list[0] ?? null;
}

function ItemRow({ item, t }: { item: TakeoverItemView; t: T }) {
  return (
    <li data-testid="takeover-item" style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13, overflowWrap: "anywhere" }}>{item.name}</strong>
        {item.kind === "database" ? <Badge tone="lapis">{t("coolifyInPlace.database.badge")}</Badge> : <Badge>{t(`coolifyInPlace.build.${item.buildMode}`)}</Badge>}
        {item.exclusive && <Badge tone="warn">{t("coolifyInPlace.exclusive")}</Badge>}
        {item.afterSwitch && <Badge tone="warn">{t("coolifyInPlace.afterSwitch")}</Badge>}
        {item.kind === "database" && item.verify && !item.skipped && <Badge tone={item.verify.state === "ok" ? "ok" : item.verify.state === "failed" ? "danger" : "muted"}>{t(`coolifyInPlace.database.verify.${item.verify.state}`)} ({t(`coolifyInPlace.database.level.${item.verify.level}`)})</Badge>}
        {item.skipped && <Badge tone="danger">{t("coolifyInPlace.skipped")}</Badge>}
      </div>
      {item.issues?.map((c) => (
        <p key={c} role="note" style={{ margin: 0, fontSize: 12, color: "var(--c-am)", lineHeight: 1.5 }}>{t(`coolifyInPlace.issue.${c}`)}</p>
      ))}
      {!item.skipped &&
        item.domains.map((d) => (
          <div key={d.host} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
            <span className="mono" style={{ overflowWrap: "anywhere", flex: "1 1 160px" }}>{d.host}</span>
            <Badge tone={CHECK_TONE[d.tempCheck]}>{t("coolifyInPlace.testShort")}: {t(`coolifyInPlace.check.${d.tempCheck}`)}</Badge>
            <Badge tone={CHECK_TONE[d.finalCheck]}>{t("coolifyInPlace.afterShort")}: {t(`coolifyInPlace.check.${d.finalCheck}`)}</Badge>
            <Badge tone={CERT_TONE[d.cert]}>{t(`coolifyInPlace.cert.${d.cert}`)}</Badge>
          </div>
        ))}
    </li>
  );
}
