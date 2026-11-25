"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Pencil } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Badge, Btn, Card } from "../ui";
import { Field, TextInput } from "../form";
import { useToast } from "../toast";
import { formatMoney, parseMoneyInput, providerName, sizeLine, type CostSource, type ServerCostView, type TeamCost } from "../../lib/costs";

const SOURCE_TONE: Record<CostSource, "ok" | "lapis" | "warn" | "muted"> = { provider: "ok", manual: "lapis", estimate: "warn", unknown: "muted" };

/** The servers of a team with their monthly price, where it comes from, a one-step correction and what uses it. */
export function ServerCostList({ team }: { team: TeamCost }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {team.servers.map((s) => (
        <ServerCostRow key={s.serverId} server={s} canManage={team.canManage} snapshotDate={team.snapshotDate} />
      ))}
    </div>
  );
}

function ServerCostRow({ server: s, canManage, snapshotDate }: { server: ServerCostView; canManage: boolean; snapshotDate: string }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [invalid, setInvalid] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["costs"] });
    qc.invalidateQueries({ queryKey: ["costs-advice"] });
  };
  const save = useMutation({
    mutationFn: (monthly: number) => api.setServerCost(s.serverId, { monthly, currency }),
    onSuccess: () => {
      setEditing(false);
      toast(t("costs.price.saved"), "success");
      refresh();
    },
  });
  const reset = useMutation({
    mutationFn: () => api.clearServerCost(s.serverId),
    onSuccess: () => {
      setEditing(false);
      toast(t("costs.price.cleared"), "success");
      refresh();
    },
  });

  const openEdit = () => {
    setAmount(s.monthlyCents !== null ? String(s.monthlyCents / 100) : "");
    setCurrency(s.currency ?? "EUR");
    setInvalid(false);
    setEditing(true);
  };
  const submit = () => {
    const n = parseMoneyInput(amount);
    if (n === null || !/^[A-Z]{3}$/.test(currency)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    save.mutate(n);
  };

  const provider = providerName(s.provider);
  const size = sizeLine(s.cores, s.memBytes, s.diskBytes);
  const unknown = s.source === "unknown";
  // A guess from the host name or the agent is a hint, not a fact: say so, and let the price replace it.
  const hint = s.providerHint === "hostname" ? t("costs.provider.fromHostname") : null;
  const similarProvider = providerName(s.similar?.provider) ?? "";
  const note = (() => {
    if (s.source === "estimate") return t("costs.estimate.list", { provider: provider ?? "", date: s.snapshotDate ?? snapshotDate });
    if (!unknown) return null;
    switch (s.unknownReason) {
      case "no_provider":
        return t("costs.unknown.noProvider");
      case "no_list":
        return t("costs.unknown.noList", { provider: provider ?? "" });
      case "no_plan":
        return t("costs.unknown.noPlan", { provider: provider ?? "" });
      default:
        return t("costs.estimate.unknown");
    }
  })();
  const badge = unknown && s.unknownReason === "no_provider" ? t("costs.unknown.provider") : t(`costs.source.${s.source}`);
  const detailsId = `cost-apps-${s.serverId}`;

  return (
    <Card style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 180px", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, fontSize: 14, overflowWrap: "anywhere" }}>{s.name}</span>
            <Badge tone={SOURCE_TONE[s.source]}>{badge}</Badge>
          </div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 3, overflowWrap: "anywhere" }}>
            {[s.planLabel, !s.planLabel ? provider : null, !s.planLabel ? size : null].filter(Boolean).join(" · ") || size}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          {s.monthlyCents !== null && s.currency ? (
            <span style={{ fontSize: 18, fontWeight: 700 }}>{t("costs.perMonth", { amount: formatMoney(s.monthlyCents, s.currency) })}</span>
          ) : (
            <span style={{ fontSize: 14, color: "var(--c-tx3)" }}>—</span>
          )}
        </div>
        {canManage && (
          <Btn variant={unknown ? "primary" : "ghost"} icon={Pencil} onClick={() => (editing ? setEditing(false) : openEdit())} aria-expanded={editing}>
            {unknown ? t("costs.price.enter") : t("costs.price.correct")}
          </Btn>
        )}
      </div>
      {note && (
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "8px 0 0" }}>
          {note}
          {s.source === "estimate" && s.snapshotVatIncluded ? ` ${t("costs.estimate.vatIncluded")}` : ""}
          {s.source === "estimate" && s.snapshotVerified === false ? ` ${t("costs.estimate.stale")}` : ""}
          {hint ? ` ${hint}` : ""}
        </p>
      )}
      {unknown && s.similar && (
        <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "4px 0 0" }}>
          {t("costs.unknown.similar", { provider: similarProvider, amount: formatMoney(s.similar.monthlyCents, s.similar.currency), date: s.similar.snapshotDate })}
        </p>
      )}

      {editing && canManage && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          style={{ marginTop: 12, borderTop: "1px solid var(--c-bd)", paddingTop: 12 }}
        >
          <p style={{ fontSize: 12, color: "var(--c-tx2)", margin: "0 0 10px" }}>{unknown ? t("costs.price.helpEnter") : s.source === "estimate" ? t("costs.price.helpEstimate") : t("costs.price.helpCorrect")}</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
            <Field label={t("costs.price.label")} htmlFor={`cost-amt-${s.serverId}`} error={invalid ? t("costs.price.invalid") : undefined}>
              <TextInput id={`cost-amt-${s.serverId}`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" />
            </Field>
            <Field label={t("costs.price.currency")} htmlFor={`cost-cur-${s.serverId}`}>
              <TextInput id={`cost-cur-${s.serverId}`} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} autoComplete="off" />
            </Field>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn type="submit" loading={save.isPending}>
              {t("costs.price.save")}
            </Btn>
            {(s.source === "manual" || s.source === "provider") && (
              <Btn variant="ghost" onClick={() => reset.mutate()} loading={reset.isPending}>
                {t("costs.price.reset")}
              </Btn>
            )}
            <Btn variant="ghost" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Btn>
          </div>
          {(save.isError || reset.isError) && (
            <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>
              {((save.error ?? reset.error) as Error).message}
            </div>
          )}
        </form>
      )}

      {s.monthlyCents !== null && (
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={detailsId}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: 0, padding: "4px 0", color: "var(--c-tx2)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
          >
            {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            {open ? t("costs.apps.hide") : t("costs.apps.show")}
          </button>
          {open && (
            <div id={detailsId} style={{ marginTop: 6 }}>
              {s.apps.length === 0 ? (
                <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0 }}>{t("costs.apps.none")}</p>
              ) : (
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                  {s.apps.map((a) => (
                    <li key={a.key}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
                        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                          {a.kind === "system" ? t("costs.apps.system") : a.name}{" "}
                          <span style={{ color: "var(--c-tx3)", fontSize: 11 }}>{t(`costs.apps.kind.${a.kind}`)}</span>
                        </span>
                        <span style={{ flexShrink: 0, color: "var(--c-tx2)" }}>
                          {s.currency ? formatMoney(a.cents, s.currency) : ""} · {Math.round(a.sharePct)}%
                        </span>
                      </div>
                      <div
                        role="img"
                        aria-label={t("costs.apps.share", { name: a.kind === "system" ? t("costs.apps.system") : a.name, pct: `${Math.round(a.sharePct)}%` })}
                        style={{ height: 6, borderRadius: 3, background: "var(--c-el)", marginTop: 4, overflow: "hidden" }}
                      >
                        <div style={{ width: `${Math.min(100, Math.max(1, a.sharePct))}%`, height: "100%", background: "var(--c-a)" }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
