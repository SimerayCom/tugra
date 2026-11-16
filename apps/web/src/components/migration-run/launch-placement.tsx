"use client";

import { useT } from "../../i18n/provider";
import { Checkbox, Field, Select } from "../form";
import { SERVER_MAP_MAX, UNKNOWN_SOURCE_HOST, defaultPlacement, placementTargetCount, type SourceServerRow } from "../../lib/migration-run";
import type { MigrationRunServerMap } from "../../lib/types";

/**
 * Multi-host placement of a guided run (R12): the plan's source hosts, each with the Tugra server it lands on. Off by default
 * (every resource lands on the target server). Turned on, EVERY source host is listed in the map, because the hub stops a run
 * with a host missing from a non-empty map rather than putting it on the default server. Only servers of the target's team are
 * offered (the hub refuses a server of another team).
 */
export function PlacementFields({
  rows,
  servers,
  defaultId,
  value,
  onChange,
  invalid,
}: {
  rows: SourceServerRow[];
  servers: Array<{ id: string; name: string }>;
  defaultId: string;
  /** null = placement off. */
  value: MigrationRunServerMap | null;
  onChange: (next: MigrationRunServerMap | null) => void;
  invalid: boolean;
}) {
  const t = useT();
  if (rows.length === 0 || servers.length < 2) return null;
  const on = value !== null;
  const options = servers.map((s) => ({ value: s.id, label: s.name }));
  const set = (ref: string, id: string) => onChange({ ...(value ?? {}), [ref]: id });
  return (
    <fieldset style={{ border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 12, margin: 0, display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <legend style={{ fontSize: 12, fontWeight: 700, color: "var(--c-tx2)", padding: "0 6px" }}>{t("migrationRun.launch.placement.title")}</legend>
      <div>
        <Checkbox checked={on} onChange={(c) => onChange(c ? defaultPlacement(rows, defaultId) : null)} label={t("migrationRun.launch.placement.toggle")} />
        <div style={{ fontSize: 11, color: "var(--c-tx3)", margin: "2px 0 0 24px", lineHeight: 1.5 }}>{t("migrationRun.launch.placement.hint")}</div>
      </div>
      {on && (
        <>
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))" }}>
            {rows.map((r) => {
              // the source's own name for the host when the plan lists one; the uuid only when it does not
              const shown = r.name ?? r.ref;
              const label = r.ref === UNKNOWN_SOURCE_HOST ? t("migrationRun.launch.placement.unknownHost") : r.name ? t("migrationRun.launch.placement.hostNamed", { name: r.name }) : t("migrationRun.launch.placement.host", { ref: r.ref });
              return (
                <Field
                  key={r.ref}
                  label={label}
                  hint={t("migrationRun.launch.placement.counts", { apps: r.apps, databases: r.databases, services: r.services, volumes: r.volumes })}
                >
                  <Select value={value?.[r.ref] ?? defaultId} onChange={(id) => set(r.ref, id)} options={options} ariaLabel={r.name ? t("migrationRun.launch.placement.targetNamed", { name: r.name }) : t("migrationRun.launch.placement.target", { ref: shown })} style={{ minHeight: 44 }} />
                </Field>
              );
            })}
          </div>
          <div style={{ fontSize: 12, color: invalid ? "var(--c-r)" : "var(--c-tx3)", lineHeight: 1.5 }} role={invalid ? "alert" : undefined}>
            {invalid
              ? t("migrationRun.launch.placement.invalid", { max: SERVER_MAP_MAX })
              : `${t("migrationRun.launch.placement.summary", { hosts: rows.length, servers: placementTargetCount(defaultId, value) })} ${t("migrationRun.launch.placement.teamOnly")}`}
          </div>
        </>
      )}
    </fieldset>
  );
}
