"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Plus } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";
import { ConfigCard, NumberInput, Select, useSaveFeedback } from "./form";
import { RowRemoveButton } from "./row-remove-button";

type PortRow = { hostPort: string; containerPort: string; protocol: "tcp" | "udp" };

/**
 * Publish extra host ports beyond the app's main port. Each row validates (whole 1..65535, both
 * ports present, host-port+protocol unique) and Save is blocked on any error — a half-filled row
 * used to be silently dropped on save (data loss). Rows wrap on narrow cards, and removing a row
 * that mirrors live config confirms first.
 */
export function ExtraPortsCard({ id, ports }: { id: string; ports: { hostPort: number; containerPort: number; protocol: "tcp" | "udp" }[] }) {
  const t = useT();
  const qc = useQueryClient();
  const feedback = useSaveFeedback("apps.saved");
  const fromProps = useCallback((): PortRow[] => ports.map((p) => ({ hostPort: String(p.hostPort), containerPort: String(p.containerPort), protocol: p.protocol })), [ports]);
  const [rows, setRows] = useState<PortRow[]>(fromProps);
  useEffect(() => { setRows(fromProps()); }, [fromProps]);
  const setRow = (i: number, patch: Partial<PortRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  // A port must be a whole 1..65535; a row needs BOTH ports or neither (a half-filled row used to
  // be silently dropped on save → data loss); and a host-port+protocol pair must be unique.
  const portErr = (v: string): string | null => {
    const s = v.trim();
    if (!/^\d+$/.test(s)) return t("apps.extraPortInvalid");
    const n = Number(s);
    if (n < 1 || n > 65535) return t("apps.extraPortRange");
    return null;
  };
  const complete = (r: PortRow) => r.hostPort.trim() !== "" && r.containerPort.trim() !== "";
  const comboCount = new Map<string, number>();
  for (const r of rows) if (complete(r) && !portErr(r.hostPort) && !portErr(r.containerPort)) {
    const k = `${Number(r.hostPort)}/${r.protocol}`;
    comboCount.set(k, (comboCount.get(k) ?? 0) + 1);
  }
  const rowErr = (r: PortRow): { field: "host" | "container" | "both"; msg: string } | null => {
    const h = r.hostPort.trim(), c = r.containerPort.trim();
    if (!h && !c) return null; // an empty row is dropped on save, not an error
    if (!h || !c) return { field: "both", msg: t("apps.extraPortIncomplete") };
    const he = portErr(h); if (he) return { field: "host", msg: he };
    const ce = portErr(c); if (ce) return { field: "container", msg: ce };
    if ((comboCount.get(`${Number(h)}/${r.protocol}`) ?? 0) > 1) return { field: "host", msg: t("apps.extraPortDup", { port: String(Number(h)), protocol: r.protocol.toUpperCase() }) };
    return null;
  };
  const errors = rows.map(rowErr);
  const hasError = errors.some(Boolean);

  const toKeys = (rs: PortRow[]) => rs.filter(complete).map((r) => `${Number(r.hostPort)}/${Number(r.containerPort)}/${r.protocol}`);
  const savedKeys = toKeys(fromProps());
  const dirty = JSON.stringify(toKeys(rows)) !== JSON.stringify(savedKeys);
  const savedSet = new Set(savedKeys);
  const isPersisted = (r: PortRow) => complete(r) && savedSet.has(`${Number(r.hostPort)}/${Number(r.containerPort)}/${r.protocol}`);

  const save = useMutation({
    mutationFn: () => api.setAppExtraPorts(id, rows.filter(complete).map((r) => ({ hostPort: Number(r.hostPort), containerPort: Number(r.containerPort), protocol: r.protocol }))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    ...feedback,
  });

  const cell = (err: boolean): CSSProperties => ({ flex: "1 1 96px", minWidth: 0, ...(err ? { borderColor: "var(--c-r)" } : {}) });

  return (
    <ConfigCard
      title={t("apps.extraPorts")}
      desc={t("apps.extraPortsDesc")}
      dirty={dirty}
      saving={save.isPending}
      saveDisabled={hasError}
      onSave={() => save.mutate()}
      actions={<Btn variant="ghost" icon={Plus} onClick={() => setRows((rs) => [...rs, { hostPort: "", containerPort: "", protocol: "tcp" }])}>{t("apps.extraPortAdd")}</Btn>}
    >
      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--c-tx3)", padding: "4px 0 2px" }}>{t("apps.extraPortsEmpty")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((r, i) => {
            const e = errors[i];
            return (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <NumberInput style={cell(e?.field === "host" || e?.field === "both")} min={1} max={65535} placeholder={t("apps.extraPortHost")} aria-label={t("apps.extraPortHost")} value={r.hostPort} onChange={(ev) => setRow(i, { hostPort: ev.target.value })} aria-invalid={e?.field === "host" || e?.field === "both"} />
                  <span style={{ color: "var(--c-tx3)" }}>:</span>
                  <NumberInput style={cell(e?.field === "container" || e?.field === "both")} min={1} max={65535} placeholder={t("apps.extraPortContainer")} aria-label={t("apps.extraPortContainer")} value={r.containerPort} onChange={(ev) => setRow(i, { containerPort: ev.target.value })} aria-invalid={e?.field === "container" || e?.field === "both"} />
                  <Select value={r.protocol} onChange={(v) => setRow(i, { protocol: v as "tcp" | "udp" })} ariaLabel={t("apps.extraPortProtocol")} options={[{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }]} style={{ flex: "0 0 92px", width: 92 }} />
                  <RowRemoveButton label={t("apps.remove")} confirm={isPersisted(r)} confirmBody={t("apps.extraPortRemoveConfirm")} onRemove={() => setRows((rs) => rs.filter((_, j) => j !== i))} />
                </div>
                {e && <span role="alert" style={{ fontSize: 11, color: "var(--c-r)" }}>{e.msg}</span>}
              </div>
            );
          })}
        </div>
      )}
    </ConfigCard>
  );
}
