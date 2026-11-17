"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink, KeyRound, Link2, MonitorSmartphone, Power, PowerOff, RotateCw, ShieldAlert, Square, TriangleAlert, Unlink } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n/provider";
import { Badge, Btn, SectionCard, Spinner } from "./ui";
import { Modal } from "./modal";
import { fieldStyle } from "./form";
import { CopyBtn } from "./copy-row";
import { useToast } from "./toast";
import { useOptionalConfirm } from "./confirm";
import type { OobConsoleResult, OobPowerAction, OobRescueResult, OobStatus } from "../lib/types";

export const OOB_QUERY_KEY = (id: string) => ["server-oob", id] as const;

/** The provider's own console page, offered as a fallback next to the one-time websocket address. */
const HETZNER_CONSOLE_URL = "https://console.hetzner.cloud/";

const KNOWN_POWER = new Set(["running", "off", "starting", "stopping", "rebuilding", "migrating", "initializing", "deleting", "unknown"]);
const TRANSITIONAL = new Set(["starting", "stopping", "rebuilding", "migrating", "initializing", "deleting"]);
const POWER_TONE: Record<string, "ok" | "muted" | "warn" | "danger"> = { running: "ok", off: "muted", unknown: "muted" };

type Destructive = "shutdown" | "reboot" | "power_off";
const DESTRUCTIVE_KEYS: Record<Destructive, { title: string; body: string; confirm: string; done: string }> = {
  shutdown: { title: "oob.confirm.titleShutdown", body: "oob.confirm.bodyShutdown", confirm: "oob.confirm.confirmShutdown", done: "oob.done.shutdown" },
  reboot: { title: "oob.confirm.titleReboot", body: "oob.confirm.bodyReboot", confirm: "oob.confirm.confirmReboot", done: "oob.done.reboot" },
  power_off: { title: "oob.confirm.titlePowerOff", body: "oob.confirm.bodyPowerOff", confirm: "oob.confirm.confirmPowerOff", done: "oob.done.powerOff" },
};

type Secret = { kind: "rescue"; res: OobRescueResult } | { kind: "console"; res: OobConsoleResult; at: number };

/**
 * Out-of-band card of a server (Maintenance tab): power, rescue and the provider console straight from the cloud
 * provider, so they work while the agent is offline. Shown only when the server is linked to a cloud server (or, for
 * writers, to offer the link). The one-time rescue password and console session live in component state only and
 * vanish when their dialog closes: nothing is cached or stored.
 */
export function ServerOobCard({ id, serverName }: { id: string; serverName: string }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const askConfirm = useOptionalConfirm();
  const [confirm, setConfirm] = useState<Destructive | "rescue" | "console" | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [linking, setLinking] = useState(false);

  const status = useQuery({
    queryKey: OOB_QUERY_KEY(id),
    queryFn: () => api.getServerOob(id),
    // Follow a power change while the provider is mid-transition; otherwise stay quiet (the provider rate-limits).
    refetchInterval: (q) => (q.state.data?.state && TRANSITIONAL.has(q.state.data.state.status) ? 5000 : false),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: OOB_QUERY_KEY(id) });

  const powerOn = useMutation({
    mutationFn: () => api.oobPower(id, { action: "power_on" }),
    onSuccess: () => {
      toast(t("oob.done.powerOn"), "success");
      refresh();
    },
  });
  const disableRescue = useMutation({
    mutationFn: () => api.oobDisableRescue(id),
    onSuccess: () => {
      toast(t("oob.done.disableRescue"), "success");
      refresh();
    },
  });
  const unlink = useMutation({ mutationFn: () => api.oobUnlink(id), onSuccess: refresh });

  const s = status.data;
  if (status.isLoading) {
    return (
      <SectionCard title={t("oob.title")} style={{ marginTop: 20 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--c-tx3)" }}><Spinner /></span>
      </SectionCard>
    );
  }
  if (!s) return null;

  // Not linked: nothing to act on. Writers get the link affordance; everyone else sees no card at all.
  if (!s.linked) {
    if (!s.canManage) return null;
    return (
      <SectionCard id="server-oob" title={t("oob.title")} desc={t("oob.link.desc")} style={{ marginTop: 20 }}>
        {s.credentialMissing && <Note tone="warn">{t("oob.link.credentialMissing")}</Note>}
        <Btn variant="ghost" icon={Link2} onClick={() => setLinking(true)}>{t("oob.link.button")}</Btn>
        <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "10px 0 0", lineHeight: 1.5 }}>{t("oob.link.howto")}</p>
        {linking && <LinkDialog id={id} serverName={serverName} onClose={() => setLinking(false)} onDone={() => { setLinking(false); refresh(); }} />}
      </SectionCard>
    );
  }

  const st = s.state;
  const power = st ? (KNOWN_POWER.has(st.status) ? st.status : "unknown") : null;
  const canAct = s.canOps && s.supported;
  const busy = powerOn.isPending || disableRescue.isPending;
  const err = (powerOn.error ?? disableRescue.error ?? unlink.error) as Error | null;

  return (
    <SectionCard id="server-oob" title={t("oob.title")} desc={t("oob.desc")} style={{ marginTop: 20 }}>
      <div data-testid="oob-state" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 6 }}>
        {power && <Badge tone={POWER_TONE[power] ?? "warn"}>{`${t("oob.power.label")}: ${t(`oob.power.${power}`)}`}</Badge>}
        {st?.rescueEnabled && <Badge tone="warn">{t("oob.rescueOn")}</Badge>}
        {st?.locked && <Badge tone="danger">{t("oob.locked")}</Badge>}
        {power && TRANSITIONAL.has(power) && <Spinner />}
        <Badge tone="muted">{s.manual ? t("oob.linkedBy.hand") : t("oob.linkedBy.tugra")}</Badge>
      </div>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", lineHeight: 1.5, marginBottom: 12, wordBreak: "break-word" }}>
        {st ? t("oob.provider", { provider: s.provider ?? "", name: st.name }) : (s.provider ?? "")}
        {s.credentialName ? ` · ${t("oob.credential", { name: s.credentialName })}` : ""}
        {st?.publicIpv4 ? ` · ${st.publicIpv4}` : ""}
      </div>
      {s.stateError && <Note tone="warn">{t("oob.stateError", { error: s.stateError })}</Note>}
      {!s.supported && <Note tone="warn">{t("oob.unsupported")}</Note>}

      {canAct ? (
        <div data-testid="oob-actions" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <Action hint="">
            <Btn variant="ghost" icon={Power} iconTone="success" onClick={() => powerOn.mutate()} loading={powerOn.isPending} disabled={busy} style={fill}>{t("oob.actions.powerOn")}</Btn>
          </Action>
          <Action hint={t("oob.hints.shutdown")}>
            <Btn variant="ghost" icon={Square} onClick={() => setConfirm("shutdown")} disabled={busy} style={fill}>{t("oob.actions.shutdown")}</Btn>
          </Action>
          <Action hint={t("oob.hints.reboot")}>
            <Btn variant="dangerGhost" icon={RotateCw} onClick={() => setConfirm("reboot")} disabled={busy} style={fill}>{t("oob.actions.reboot")}</Btn>
          </Action>
          <Action hint={t("oob.hints.powerOff")}>
            <Btn variant="dangerGhost" icon={PowerOff} onClick={() => setConfirm("power_off")} disabled={busy} style={fill}>{t("oob.actions.powerOff")}</Btn>
          </Action>
          <Action hint={t("oob.hints.rescue")}>
            {st?.rescueEnabled ? (
              <Btn variant="ghost" icon={KeyRound} onClick={() => disableRescue.mutate()} loading={disableRescue.isPending} disabled={busy} style={fill}>{t("oob.actions.disableRescue")}</Btn>
            ) : (
              <Btn variant="ghost" icon={KeyRound} onClick={() => setConfirm("rescue")} disabled={busy} style={fill}>{t("oob.actions.enableRescue")}</Btn>
            )}
          </Action>
          <Action hint={t("oob.hints.console")}>
            <Btn variant="ghost" icon={MonitorSmartphone} onClick={() => setConfirm("console")} disabled={busy} style={fill}>{t("oob.actions.console")}</Btn>
          </Action>
        </div>
      ) : (
        s.supported && <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0 }}>{t("oob.viewOnly")}</p>
      )}

      {err && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginTop: 10 }}>{err.message}</div>}
      {s.manual && s.canManage && (
        <div style={{ marginTop: 14 }}>
          <Btn
            variant="ghost"
            icon={Unlink}
            loading={unlink.isPending}
            onClick={async () => {
              if (!askConfirm || (await askConfirm({ body: t("oob.link.unlinkConfirm"), danger: true, confirmLabel: t("oob.link.unlink") }))) unlink.mutate();
            }}
          >
            {t("oob.link.unlink")}
          </Btn>
        </div>
      )}

      {confirm && confirm !== "rescue" && confirm !== "console" && (
        <PowerDialog
          id={id}
          serverName={serverName}
          action={confirm}
          onClose={() => setConfirm(null)}
          onDone={() => {
            setConfirm(null);
            refresh();
          }}
        />
      )}
      {confirm === "rescue" && (
        <SecretRequestDialog
          title={t("oob.confirm.rescueTitle", { server: serverName })}
          body={t("oob.confirm.rescueBody", { minutes: 60 })}
          confirmLabel={t("oob.confirm.rescueConfirm")}
          run={() => api.oobEnableRescue(id)}
          onClose={() => setConfirm(null)}
          onResult={(res) => {
            setConfirm(null);
            setSecret({ kind: "rescue", res });
            refresh();
          }}
        />
      )}
      {confirm === "console" && (
        <SecretRequestDialog
          title={t("oob.confirm.consoleTitle", { server: serverName })}
          body={t("oob.confirm.consoleBody")}
          confirmLabel={t("oob.confirm.consoleConfirm")}
          run={() => api.oobConsole(id)}
          onClose={() => setConfirm(null)}
          onResult={(res) => {
            setConfirm(null);
            setSecret({ kind: "console", res, at: Date.now() });
          }}
        />
      )}
      {secret && <SecretDialog secret={secret} onClose={() => setSecret(null)} />}
    </SectionCard>
  );
}

const fill = { width: "100%", justifyContent: "center", minHeight: 40 } as const;

function Action({ hint, children }: { hint: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {children}
      {hint && <span style={{ fontSize: 11, color: "var(--c-tx3)", lineHeight: 1.4 }}>{hint}</span>}
    </div>
  );
}

function Note({ tone, children }: { tone: "warn"; children: ReactNode }) {
  return (
    <div role="note" style={{ display: "flex", alignItems: "flex-start", gap: 6, color: tone === "warn" ? "var(--c-am)" : "var(--c-tx2)", margin: "0 0 10px", fontSize: 12, lineHeight: 1.5 }}>
      <TriangleAlert size={13} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
      <span>{children}</span>
    </div>
  );
}

// ── typed-name confirmation for the actions that take the server down ───────────────────────────────────────────────

function PowerDialog({ id, serverName, action, onClose, onDone }: { id: string; serverName: string; action: Destructive; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const keys = DESTRUCTIVE_KEYS[action];
  const send = useMutation({
    mutationFn: () => api.oobPower(id, { action: action as OobPowerAction, confirmName: typed }),
    onSuccess: () => {
      toast(t(keys.done), "success");
      onDone();
    },
  });
  const canSend = typed === serverName && serverName.length > 0 && !send.isPending;
  return (
    <Modal onClose={onClose} labelledBy="oob-dlg-title" closeOnBackdrop={false}>
      <h3 id="oob-dlg-title" style={{ margin: "0 0 10px", fontSize: 15 }}>{t(keys.title, { server: serverName })}</h3>
      <p style={{ fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5, margin: "0 0 12px" }}>{t(keys.body)}</p>
      <label style={{ display: "block", marginBottom: 14 }}>
        <span style={{ display: "block", fontSize: 12, color: "var(--c-tx2)", marginBottom: 6, lineHeight: 1.5 }}>{t("oob.confirm.typeToConfirm", { name: serverName })}</span>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSend) send.mutate();
          }}
          aria-label={t("oob.confirm.typeToConfirm", { name: serverName })}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          style={fieldStyle}
        />
      </label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose} disabled={send.isPending}>{t("oob.confirm.cancel")}</Btn>
        <Btn variant="danger" onClick={() => send.mutate()} disabled={!canSend} loading={send.isPending}>{t(keys.confirm)}</Btn>
      </div>
      {send.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(send.error as Error).message}</div>}
    </Modal>
  );
}

// ── actions that return a one-time secret: a plain confirmation, then the secret dialog ────────────────────────────

function SecretRequestDialog<R>({ title, body, confirmLabel, run, onClose, onResult }: { title: string; body: string; confirmLabel: string; run: () => Promise<R>; onClose: () => void; onResult: (res: R) => void }) {
  const t = useT();
  // gcTime 0: the response (it holds the secret) is dropped from the query cache as soon as it is handed over.
  const send = useMutation({ mutationFn: run, gcTime: 0, onSuccess: (res) => onResult(res) });
  return (
    <Modal onClose={onClose} labelledBy="oob-secret-req-title" closeOnBackdrop={false}>
      <h3 id="oob-secret-req-title" style={{ margin: "0 0 10px", fontSize: 15 }}>{title}</h3>
      <p style={{ fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5, margin: "0 0 14px" }}>{body}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose} disabled={send.isPending}>{t("oob.confirm.cancel")}</Btn>
        <Btn onClick={() => send.mutate()} loading={send.isPending}>{confirmLabel}</Btn>
      </div>
      {send.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(send.error as Error).message}</div>}
    </Modal>
  );
}

function SecretField({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{label}</div>
      <code className="mono" data-testid="oob-secret" style={{ display: "block", fontSize: 12, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "8px 10px", wordBreak: "break-all", userSelect: "all" }}>{value}</code>
      <div style={{ marginTop: 4 }}><CopyBtn text={value} /></div>
    </div>
  );
}

function SecretDialog({ secret, onClose }: { secret: Secret; onClose: () => void }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  const isConsole = secret.kind === "console";
  useEffect(() => {
    if (!isConsole) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isConsole]);
  const left = secret.kind === "console" ? Math.max(0, secret.res.validForSeconds - Math.floor((now - secret.at) / 1000)) : null;

  return (
    <Modal onClose={onClose} labelledBy="oob-secret-title" closeOnBackdrop={false} closeOnEsc={false}>
      <h3 id="oob-secret-title" style={{ margin: "0 0 8px", fontSize: 15 }}>{secret.kind === "rescue" ? t("oob.secret.rescueTitle") : t("oob.secret.consoleTitle")}</h3>
      <p style={{ fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5, margin: "0 0 10px" }}>
        {secret.kind === "rescue" ? t("oob.secret.rescueBody", { minutes: secret.res.expiresInMinutes }) : t("oob.secret.consoleBody")}
      </p>
      <Note tone="warn">{t("oob.secret.once")}</Note>
      {secret.kind === "rescue" ? (
        <SecretField label={t("oob.secret.rootPassword")} value={secret.res.rootPassword} />
      ) : (
        <>
          <SecretField label={t("oob.secret.wssUrl")} value={secret.res.wssUrl} />
          <SecretField label={t("oob.secret.vncPassword")} value={secret.res.password} />
          <div role="status" aria-live="polite" style={{ fontSize: 12, color: left === 0 ? "var(--c-r)" : "var(--c-tx3)", marginBottom: 10 }}>
            {left === 0 ? t("oob.secret.expired") : t("oob.secret.expiresIn", { seconds: left ?? 0 })}
          </div>
          <a href={HETZNER_CONSOLE_URL} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 12 }}>
            <ExternalLink size={13} aria-hidden /> {t("oob.secret.providerConsole")}
          </a>
        </>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Btn onClick={onClose}>{t("oob.secret.close")}</Btn>
      </div>
    </Modal>
  );
}

// ── link an existing server to its cloud server ─────────────────────────────────────────────────────────────────────

function LinkDialog({ id, serverName, onClose, onDone }: { id: string; serverName: string; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const creds = useQuery({ queryKey: ["cloud-credentials"], queryFn: () => api.listCloudCredentials() });
  const server = useQuery({ queryKey: ["server", id], queryFn: () => api.getServer(id), staleTime: 30_000 });
  const hetzner = (creds.data ?? []).filter((c) => c.provider === "hetzner" && (!server.data || c.teamId === server.data.teamId));
  const [credId, setCredId] = useState("");
  const [pick, setPick] = useState("");
  const [typed, setTyped] = useState("");
  const cid = credId || hetzner[0]?.id || "";
  const candidates = useQuery({ queryKey: ["server-oob-candidates", id, cid], queryFn: () => api.oobCandidates(id, cid), enabled: !!cid, staleTime: 0, gcTime: 0 });
  const chosen = candidates.data?.find((c) => c.providerServerId === pick) ?? null;
  // The hub's own verdict can say "unverified" even when we thought the IP matched; it names the server to type.
  const [hubName, setHubName] = useState<string | null>(null);
  const needsName = chosen ? !chosen.matchesIp || hubName !== null : false;
  const nameToType = hubName ?? chosen?.name ?? "";
  const link = useMutation({
    mutationFn: () => api.oobLink(id, { cloudCredentialId: cid, providerServerId: pick, ...(needsName ? { confirmProviderName: typed } : {}) }),
    onSuccess: onDone,
    onError: (e) => {
      if (e instanceof ApiError && e.code === "oob_link_unverified" && typeof e.data?.providerServerName === "string") setHubName(e.data.providerServerName);
    },
  });
  const canLink = !!chosen && !chosen.taken && (!needsName || typed === nameToType) && !link.isPending;

  return (
    <Modal onClose={onClose} labelledBy="oob-link-title" closeOnBackdrop={false}>
      <h3 id="oob-link-title" style={{ margin: "0 0 10px", fontSize: 15 }}>{t("oob.link.dialogTitle", { server: serverName })}</h3>
      {creds.isLoading ? (
        <Spinner />
      ) : hetzner.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--c-tx2)", lineHeight: 1.5 }}>{t("oob.link.noCredential")}</p>
      ) : (
        <>
          <label style={{ display: "block", marginBottom: 12 }}>
            <span style={{ display: "block", fontSize: 12, color: "var(--c-tx2)", marginBottom: 6 }}>{t("oob.link.credential")}</span>
            <select value={cid} onChange={(e) => { setCredId(e.target.value); setPick(""); setHubName(null); }} style={fieldStyle} aria-label={t("oob.link.credential")}>
              {hetzner.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <div style={{ fontSize: 12, color: "var(--c-tx2)", marginBottom: 6 }}>{t("oob.link.pick")}</div>
          {candidates.isLoading ? (
            <span style={{ fontSize: 12, color: "var(--c-tx3)", display: "inline-flex", gap: 6, alignItems: "center" }}><Spinner /> {t("oob.link.loading")}</span>
          ) : candidates.isError ? (
            <div role="alert" style={{ color: "var(--c-r)", fontSize: 12 }}>{(candidates.error as Error).message}</div>
          ) : (candidates.data ?? []).length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("oob.link.none")}</p>
          ) : (
            <ul role="radiogroup" aria-label={t("oob.link.pick")} style={{ listStyle: "none", margin: "0 0 12px", padding: 0, display: "grid", gap: 6, maxHeight: 260, overflowY: "auto" }}>
              {(candidates.data ?? []).map((c) => (
                <li key={c.providerServerId}>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", border: `1px solid ${pick === c.providerServerId ? "var(--c-a)" : "var(--c-bd)"}`, borderRadius: "var(--r1)", opacity: c.taken ? 0.55 : 1, cursor: c.taken ? "not-allowed" : "pointer" }}>
                    <input type="radio" name="oob-candidate" disabled={c.taken} checked={pick === c.providerServerId} onChange={() => { setPick(c.providerServerId); setTyped(""); setHubName(null); }} style={{ marginTop: 3 }} />
                    <span style={{ minWidth: 0, fontSize: 13, wordBreak: "break-word" }}>
                      <strong>{c.name}</strong> <span style={{ color: "var(--c-tx3)" }}>#{c.providerServerId}</span>
                      <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)" }}>
                        {c.publicIpv4 ? t("oob.link.ip", { ip: c.publicIpv4 }) : t("oob.link.noIp")} · {c.status}
                      </span>
                      <span style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                        {c.matchesIp && <Badge tone="ok">{t("oob.link.matches")}</Badge>}
                        {c.taken && <Badge tone="muted">{t("oob.link.taken")}</Badge>}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {chosen && needsName && (
            <div style={{ marginBottom: 12 }}>
              <div role="note" style={{ display: "flex", gap: 6, color: "var(--c-am)", fontSize: 12, lineHeight: 1.5, marginBottom: 8 }}>
                <ShieldAlert size={14} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
                <span><strong>{t("oob.link.mismatchTitle")}.</strong> {t("oob.link.mismatchBody", { name: nameToType })}</span>
              </div>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={t("oob.link.mismatchBody", { name: nameToType })} autoComplete="off" autoCapitalize="off" spellCheck={false} style={fieldStyle} />
            </div>
          )}
        </>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="ghost" onClick={onClose} disabled={link.isPending}>{t("oob.link.cancel")}</Btn>
        <Btn onClick={() => link.mutate()} disabled={!canLink} loading={link.isPending}>{t("oob.link.confirm")}</Btn>
      </div>
      {link.isError && <div role="alert" style={{ color: "var(--c-r)", fontSize: 12, marginTop: 8 }}>{(link.error as Error).message}</div>}
    </Modal>
  );
}
