"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn, SectionCard } from "../ui";
import { Field, TextInput } from "../form";
import { IconBtn } from "../icon-btn";
import { CopyBtn } from "../copy-row";
import { useToast } from "../toast";
import { formatMoney, parseMoneyInput, type TeamCost } from "../../lib/costs";

/** "Before and after migration": save today's bill (or type what was paid), then see what the new setup saves. */
export function BeforeAfterCard({ team }: { team: TeamCost }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [typed, setTyped] = useState("");
  const [typedCurrency, setTypedCurrency] = useState(team.totals[0]?.currency ?? "EUR");
  const [invalid, setInvalid] = useState(false);
  const [replacing, setReplacing] = useState(false);

  const done = () => {
    qc.invalidateQueries({ queryKey: ["costs"] });
    setReplacing(false);
    setLabel("");
    setTyped("");
  };
  const saveNow = useMutation({
    mutationFn: () => api.createCostBaseline({ teamId: team.teamId, ...(label.trim() ? { label: label.trim() } : {}) }),
    onSuccess: () => {
      toast(t("costs.compare.saved"), "success");
      done();
    },
  });
  const saveTyped = useMutation({
    mutationFn: (monthly: number) => api.createCostBaseline({ teamId: team.teamId, monthly, currency: typedCurrency, ...(label.trim() ? { label: label.trim() } : {}) }),
    onSuccess: () => {
      toast(t("costs.compare.saved"), "success");
      done();
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteCostBaseline(id),
    onSuccess: () => {
      toast(t("costs.compare.deleted"), "success");
      qc.invalidateQueries({ queryKey: ["costs"] });
    },
  });

  const cmp = team.comparison;
  const latest = team.baselines[0];
  const showForm = team.canManage && (!latest || replacing);
  const pricedCurrencies = new Set(team.totals.map((x) => x.currency));
  const canSnapshot = team.totals.length > 0 && pricedCurrencies.size === 1;

  let summary: string | null = null;
  if (cmp) {
    const before = formatMoney(cmp.beforeCents, cmp.currency);
    const after = formatMoney(cmp.afterCents, cmp.currency);
    summary =
      cmp.deltaCents < 0
        ? t("costs.compare.lower", { before, after, saved: formatMoney(-cmp.deltaCents, cmp.currency), yearly: formatMoney(-cmp.yearlyDeltaCents, cmp.currency) })
        : cmp.deltaCents > 0
          ? t("costs.compare.higher", { before, after })
          : t("costs.compare.same", { after });
  }

  const submitTyped = () => {
    const n = parseMoneyInput(typed);
    if (n === null || !/^[A-Z]{3}$/.test(typedCurrency)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    saveTyped.mutate(n);
  };

  return (
    <SectionCard title={t("costs.compare.title")} desc={t("costs.compare.desc")}>
      {cmp && summary && latest && (
        <div style={{ marginBottom: showForm ? 16 : 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12 }}>
            <Figure label={t("costs.compare.before")} value={formatMoney(cmp.beforeCents, cmp.currency)} sub={latest.label} />
            <Figure label={t("costs.compare.after")} value={formatMoney(cmp.afterCents, cmp.currency)} accent />
          </div>
          <p style={{ fontSize: 14, margin: "12px 0 0" }} role="status">
            {summary}
          </p>
          {cmp.includesEstimates && <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "4px 0 0" }}>{t("costs.compare.estimates")}</p>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
            <CopyBtn text={summary} label={t("costs.compare.copy")} />
            {team.canManage && !replacing && (
              <Btn variant="ghost" onClick={() => setReplacing(true)}>
                {t("costs.compare.replace")}
              </Btn>
            )}
            {team.canManage && (
              <IconBtn label={t("costs.compare.delete")} danger onClick={() => del.mutate(latest.id)}>
                <Trash2 size={15} />
              </IconBtn>
            )}
          </div>
        </div>
      )}
      {!cmp && latest && (
        <p style={{ fontSize: 13, color: "var(--c-tx3)", margin: 0 }}>
          {t("costs.compare.before")}: {formatMoney(latest.monthlyCents, latest.currency)} · {t("costs.compare.savedOn", { date: new Date(latest.createdAt).toLocaleDateString("en") })}
        </p>
      )}

      {showForm && (
        <div>
          <Field label={t("costs.compare.labelField")} htmlFor={`cmp-label-${team.teamId}`}>
            <TextInput id={`cmp-label-${team.teamId}`} value={label} maxLength={80} placeholder={t("costs.compare.labelPlaceholder")} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <div style={{ marginTop: 12 }}>
            <Btn onClick={() => saveNow.mutate()} loading={saveNow.isPending} disabled={!canSnapshot}>
              {t("costs.compare.saveNow")}
            </Btn>
            {!canSnapshot && (
              <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "6px 0 0" }}>{pricedCurrencies.size > 1 ? t("costs.compare.mixed") : t("costs.compare.needsPrices")}</p>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitTyped();
            }}
            style={{ marginTop: 16, borderTop: "1px solid var(--c-bd)", paddingTop: 14 }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)", marginBottom: 8 }}>{t("costs.compare.typed")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
              <Field label={t("costs.compare.typedAmount")} htmlFor={`cmp-amt-${team.teamId}`} error={invalid ? t("costs.price.invalid") : undefined}>
                <TextInput id={`cmp-amt-${team.teamId}`} inputMode="decimal" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
              </Field>
              <Field label={t("costs.price.currency")} htmlFor={`cmp-cur-${team.teamId}`}>
                <TextInput id={`cmp-cur-${team.teamId}`} value={typedCurrency} maxLength={3} onChange={(e) => setTypedCurrency(e.target.value.toUpperCase())} autoComplete="off" />
              </Field>
            </div>
            <div style={{ marginTop: 12 }}>
              <Btn type="submit" variant="ghost" loading={saveTyped.isPending}>
                {t("costs.compare.typedSave")}
              </Btn>
            </div>
          </form>
          {(saveNow.isError || saveTyped.isError) && (
            <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>
              {((saveNow.error ?? saveTyped.error) as Error).message}
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function Figure({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div style={{ background: "var(--c-el)", borderRadius: "var(--r1)", padding: 12, minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent ? "var(--c-a)" : "var(--c-tx)", marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--c-tx3)", overflowWrap: "anywhere" }}>{sub}</div>}
    </div>
  );
}
