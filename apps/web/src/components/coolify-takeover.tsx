"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n/provider";
import { relativeTime } from "../lib/fleet";
import { coolifyVersion, type CoolifyDetect } from "../lib/coolify-takeover";
import { Badge, Btn, Card, SectionCard, Working } from "./ui";
import { Field, Select } from "./form";
import { useConfirm } from "./confirm";
import { CoolifyInventoryBody } from "./coolify-inventory-view";
import { CoolifyServersChecklist } from "./coolify-servers-checklist";
import { BlockedNote } from "./cta-parts";
import { blockTag, serverBlock } from "../lib/cta-readiness";

/** A localized line for a failed call: the hub's stable code when we know it, else a generic one. */
function errorText(t: ReturnType<typeof useT>, e: unknown): string {
  if (e instanceof ApiError) {
    const key = `coolifyTakeover.error.${e.code ?? ""}`;
    const text = t(key);
    if (e.code && text !== key) return text;
    if (e.status === 403) return t("coolifyTakeover.error.forbidden");
    if (e.status === 503) return t("coolifyTakeover.error.offline");
  }
  return t("coolifyTakeover.error.generic");
}

/** Pick a server, allow reading its Coolify (explicit opt-in), read it, then browse the read-only copy. */
export function CoolifyTakeover() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [serverId, setServerId] = useState("");
  // A server's scan card can send the user here with ?server=<id>: start on that server.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("server");
    if (id) setServerId((cur) => cur || id);
  }, []);
  const [detect, setDetect] = useState<CoolifyDetect | null>(null);

  const { data: servers = [], isLoading: loadingServers } = useQuery({ queryKey: ["servers", "all"], queryFn: () => api.listServers() });
  const invKey = ["coolify-inventory", serverId];
  const inv = useQuery({
    queryKey: invKey,
    queryFn: () => api.coolifyInventory(serverId),
    enabled: !!serverId,
    retry: false,
  });
  const notEnabled = inv.error instanceof ApiError && inv.error.code === "not_enabled";

  const check = useMutation({ mutationFn: () => api.coolifyDetect(serverId), onSuccess: setDetect });
  const read = useMutation({
    mutationFn: () => api.coolifyRead(serverId),
    onSuccess: (v) => {
      qc.setQueryData(invKey, v);
      qc.invalidateQueries({ queryKey: ["coolify-servers", serverId] });
    },
    meta: { successMessage: t("coolifyTakeover.read.done") },
  });
  const allow = useMutation({
    mutationFn: async () => {
      await api.coolifyEnable(serverId);
      return api.coolifyRead(serverId);
    },
    onSuccess: (v) => {
      qc.setQueryData(invKey, v);
      setDetect(null);
    },
    meta: { successMessage: t("coolifyTakeover.read.done") },
    // The opt-in is kept even when the first read fails: the page then offers "Read now".
    onError: () => qc.invalidateQueries({ queryKey: invKey }),
  });
  const stop = useMutation({
    mutationFn: () => api.coolifyDisable(serverId),
    onSuccess: () => {
      qc.removeQueries({ queryKey: invKey });
      qc.removeQueries({ queryKey: ["coolify-servers", serverId] });
      setDetect(null);
      inv.refetch();
    },
    meta: { successMessage: t("coolifyTakeover.stop.done") },
  });

  const pick = (id: string) => {
    setServerId(id);
    setDetect(null);
    check.reset();
    read.reset();
    allow.reset();
  };
  const onStop = async () => {
    const ok = await confirm({ title: t("coolifyTakeover.stop.title"), body: t("coolifyTakeover.stop.body"), confirmLabel: t("coolifyTakeover.stop.confirm"), danger: true });
    if (ok) stop.mutate();
  };

  const picked = servers.find((s) => s.id === serverId);
  const pickedBlock = picked ? serverBlock(picked, ["database"], { write: false }) : null;
  const failure = check.error ?? read.error ?? allow.error ?? stop.error;
  const detectNote = detect
    ? detect.found
      ? coolifyVersion(detect.image)
        ? t("coolifyTakeover.optIn.found", { version: coolifyVersion(detect.image) ?? "" })
        : t("coolifyTakeover.optIn.foundNoVersion")
      : detect.reason === "no_docker"
        ? t("coolifyTakeover.optIn.noDocker")
        : detect.reason === "db_stopped"
          ? t("coolifyTakeover.optIn.dbStopped")
          : t("coolifyTakeover.optIn.notFound")
    : null;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card style={{ padding: 16 }}>
        <Field label={t("coolifyTakeover.pick.label")} hint={servers.length === 0 && !loadingServers ? t("coolifyTakeover.pick.none") : t("coolifyTakeover.pick.hint")}>
          <Select
            value={serverId}
            onChange={pick}
            placeholder={t("coolifyTakeover.pick.placeholder")}
            options={servers.map((s) => {
              const b = serverBlock(s, ["database"], { write: false });
              return { value: s.id, label: b ? `${s.name} (${blockTag(t, b)})` : s.name, disabled: !!b };
            })}
          />
        </Field>
        {pickedBlock && <BlockedNote block={pickedBlock} serverId={serverId} style={{ display: "block", marginTop: 6 }} />}
        <p style={{ margin: "8px 0 0", fontSize: 12 }}>
          <Link href="/servers/new" style={{ color: "var(--c-lapis)" }}>{t("servers.cta.addServer")}</Link>
        </p>
      </Card>

      {serverId && inv.isFetching && !inv.data && <Working text={t("coolifyTakeover.pick.loading", { name: picked?.name ?? "" })} />}

      {failure && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--c-r)" }}>
          {errorText(t, failure)}
        </p>
      )}

      {serverId && inv.isError && !notEnabled && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--c-r)" }}>
          {errorText(t, inv.error)}
        </p>
      )}

      {serverId && notEnabled && (
        <SectionCard title={t("coolifyTakeover.optIn.title")} desc={t("coolifyTakeover.optIn.desc")}>
          <ul style={{ margin: "0 0 12px", paddingLeft: 18, fontSize: 13, color: "var(--c-tx2)", display: "grid", gap: 4 }}>
            <li>{t("coolifyTakeover.optIn.readOnly")}</li>
            <li>{t("coolifyTakeover.optIn.noSecrets")}</li>
            <li>{t("coolifyTakeover.optIn.audit")}</li>
            <li>{t("coolifyTakeover.optIn.stop")}</li>
          </ul>
          {detectNote && (
            <p role="status" style={{ margin: "0 0 12px", fontSize: 13, color: detect?.found ? "var(--c-g)" : "var(--c-am)" }}>
              {detectNote}
            </p>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="ghost" loading={check.isPending} onClick={() => check.mutate()}>
              {check.isPending ? t("coolifyTakeover.optIn.checking") : t("coolifyTakeover.optIn.check")}
            </Btn>
            <Btn disabled={!detect?.found} loading={allow.isPending} onClick={() => allow.mutate()}>
              {allow.isPending ? t("coolifyTakeover.read.reading") : t("coolifyTakeover.optIn.allow")}
            </Btn>
          </div>
        </SectionCard>
      )}

      {serverId && inv.data && !inv.data.data && (
        <SectionCard title={t("coolifyTakeover.title")} desc={t("coolifyTakeover.read.empty")}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn loading={read.isPending} disabled={stop.isPending} onClick={() => read.mutate()}>
              {read.isPending ? t("coolifyTakeover.read.reading") : t("coolifyTakeover.read.now")}
            </Btn>
            <Btn variant="ghost" loading={stop.isPending} disabled={read.isPending} onClick={onStop}>
              {stop.isPending ? t("coolifyTakeover.stop.stopping") : t("coolifyTakeover.stop.button")}
            </Btn>
          </div>
        </SectionCard>
      )}

      {serverId && inv.data?.data && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Btn variant="ghost" loading={read.isPending} disabled={stop.isPending} onClick={() => read.mutate()}>
              {read.isPending ? t("coolifyTakeover.read.reading") : t("coolifyTakeover.read.again")}
            </Btn>
            <Btn variant="dangerGhost" loading={stop.isPending} disabled={read.isPending} onClick={onStop}>
              {stop.isPending ? t("coolifyTakeover.stop.stopping") : t("coolifyTakeover.stop.button")}
            </Btn>
            {inv.data.readAt && <Badge>{t("coolifyTakeover.read.readAt", { when: relativeTime(inv.data.readAt) })}</Badge>}
          </div>
          <CoolifyInventoryBody inv={inv.data} />
          <CoolifyServersChecklist serverId={serverId} />
        </>
      )}
    </div>
  );
}
