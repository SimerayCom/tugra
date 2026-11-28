"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { SectionCard, Btn, Spinner } from "../ui";
import { useToast } from "../toast";
import { CopyBtn } from "../copy-row";
import type { ImportGitLinkRow, ImportGitStatus, ImportPlan, ImportRelinkResult } from "../../lib/types";

/** Literal keys so static key-usage checks keep working. */
export const GIT_GROUP_KEY: Record<ImportGitStatus, string> = {
  linked: "import.git.group.linked",
  public_ok: "import.git.group.publicOk",
  needs_source: "import.git.group.needsSource",
  ambiguous: "import.git.group.ambiguous",
  ssh_deploy_key: "import.git.group.sshDeployKey",
  unsupported_host: "import.git.group.unsupportedHost",
  unknown: "import.git.group.unknown",
};
const STATUS_KEY: Record<ImportGitStatus, string> = {
  linked: "import.git.status.linked",
  public_ok: "import.git.status.public_ok",
  needs_source: "import.git.status.needs_source",
  ambiguous: "import.git.status.ambiguous",
  ssh_deploy_key: "import.git.status.ssh_deploy_key",
  unsupported_host: "import.git.status.unsupported_host",
  unknown: "import.git.status.unknown",
};
const OUTCOME_KEY = {
  linked: "import.git.outcome.linked",
  already_linked: "import.git.outcome.already_linked",
  not_linked: "import.git.outcome.not_linked",
  invalid_choice: "import.git.outcome.invalid_choice",
  failed: "import.git.outcome.failed",
} as const;
const ORDER: ImportGitStatus[] = ["linked", "public_ok", "needs_source", "ambiguous", "ssh_deploy_key", "unsupported_host", "unknown"];
const tone = (s: ImportGitStatus): string => (s === "linked" || s === "public_ok" ? "var(--c-g)" : s === "ssh_deploy_key" ? "var(--c-tx3)" : "var(--c-am)");

/** Pure: rows -> per-status, per-owner buckets (74 apps under one org => one owner group). */
export function bucketGitLinks(rows: ImportGitLinkRow[]): Array<{ status: ImportGitStatus; total: number; owners: Array<{ key: string; label: string; apps: ImportGitLinkRow[] }> }> {
  const out: ReturnType<typeof bucketGitLinks> = [];
  for (const status of ORDER) {
    const inStatus = rows.filter((r) => r.status === status);
    if (inStatus.length === 0) continue;
    const owners = new Map<string, { key: string; label: string; apps: ImportGitLinkRow[] }>();
    for (const r of inStatus) {
      const label = r.repo ? `${r.repo.host}/${r.repo.owner}` : "-";
      const o = owners.get(label) ?? { key: label, label, apps: [] };
      o.apps.push(r);
      owners.set(label, o);
    }
    out.push({ status, total: inStatus.length, owners: [...owners.values()].sort((a, b) => (a.label < b.label ? -1 : 1)) });
  }
  return out;
}

/** Pure: only the git apps of the (scoped) plan. The hub answers for every app of the source; what is out of scope is neither listed nor counted. */
export function gitLinksInScope(rows: ImportGitLinkRow[], plan: Pick<ImportPlan, "items">): ImportGitLinkRow[] {
  const inScope = new Set(plan.items.map((i) => i.itemRef));
  return rows.filter((r) => inScope.has(r.itemRef));
}

/** Pure: the git hosts of these rows with their app counts, the largest first. */
export function gitHostsOf(rows: ImportGitLinkRow[]): Array<{ host: string; apps: number }> {
  const n = new Map<string, number>();
  for (const r of rows) if (r.repo) n.set(r.repo.host, (n.get(r.repo.host) ?? 0) + 1);
  return [...n.entries()].map(([host, apps]) => ({ host, apps })).sort((a, b) => b.apps - a.apps || (a.host < b.host ? -1 : 1));
}

/**
 * Before Apply: how each git app would be linked on the target team (repo-visibility matching), grouped by status
 * then by owner, with "Connect GitHub" (opens the Git sources page in a NEW tab so the wizard session survives) and
 * "Re-check". Presentation only: the hub resolves; this never sees a credential.
 */
export function GitLinksPanel({ sessionId, targetServerId, plan }: { sessionId: string; targetServerId: string; plan: ImportPlan }) {
  const t = useT();
  const q = useQuery({
    queryKey: ["import-git-links", sessionId, targetServerId],
    queryFn: () => api.importGitLinks({ sessionId, targetServerId }),
    enabled: !!sessionId && !!targetServerId,
    refetchOnWindowFocus: false, // re-checking probes GitHub: only on the operator's explicit "Re-check"
    staleTime: Infinity,
    retry: false,
  });
  // the hub resolves every git app of the source; this card is about the ones in scope (the plan it is given is the scoped one)
  const rows = gitLinksInScope(q.data?.rows ?? [], plan);
  const hosts = gitHostsOf(rows);
  const buckets = bucketGitLinks(rows);
  return (
    <SectionCard
      title={t("import.git.title")}
      desc={t("import.git.body")}
      right={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a href="/sources" target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
            <Btn variant="ghost">{t("import.git.connectGithub")}</Btn>
          </a>
          <Btn variant="ghost" onClick={() => q.refetch()} disabled={q.isFetching}>{t("import.git.recheck")}</Btn>
        </div>
      }
      style={{ padding: 16, marginBottom: 0 }}
    >
      {hosts.length > 0 && <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "0 0 10px" }}>{t("import.git.hosts", { list: hosts.map((h) => `${h.host} x${h.apps}`).join(", ") })}</p>}
      {q.isLoading || q.isFetching ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--c-tx3)" }}><Spinner /> {t("import.git.loading")}</div>
      ) : q.isError ? (
        <div role="alert" style={{ fontSize: 12, color: "var(--c-r)" }}>{t("import.git.error")}</div>
      ) : q.data && rows.length === 0 ? (
        <p data-testid="git-none-in-scope" style={{ fontSize: 12, color: "var(--c-tx3)", margin: 0 }}>{t("import.git.noneInScope")}</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {buckets.map((b) => (
            <div key={b.status}>
              <div style={{ fontSize: 13, fontWeight: 600, color: tone(b.status) }}>
                {t(GIT_GROUP_KEY[b.status])} <span style={{ color: "var(--c-tx3)", fontWeight: 400 }}>({b.total})</span>
              </div>
              {b.status === "unsupported_host" && <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "2px 0 4px" }}>{t("import.git.gitlabNote")}</p>}
              {b.owners.map((o) => (
                <details key={o.key} style={{ marginLeft: 8, marginTop: 4 }}>
                  <summary style={{ cursor: "pointer", fontSize: 12 }}>
                    <span className="mono" style={{ wordBreak: "break-all" }}>{o.label}</span> <span style={{ color: "var(--c-tx3)" }}>- {t("import.git.appsCount", { n: o.apps.length })}</span>
                  </summary>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 11 }}>
                    {o.apps.map((a) => (
                      <li key={a.itemRef} style={{ wordBreak: "break-word" }}>
                        <span className="mono" style={{ wordBreak: "break-all" }}>{a.name}</span>
                        {a.sourceName && <span style={{ color: "var(--c-tx3)" }}> - {a.sourceName}</span>}
                        {a.rewriteUrl && <span style={{ color: "var(--c-tx3)" }}> - {t("import.git.sshConverted")}</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

/**
 * After the import: "Link now" re-resolves the created apps that are still unlinked and links the covered ones; an
 * ambiguous app lists its candidate sources so the operator picks one. Calls the relink endpoint only.
 */
export function GitRelinkCard({ opId }: { opId: string }) {
  const t = useT();
  const toast = useToast();
  const [results, setResults] = useState<ImportRelinkResult[] | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const relink = useMutation({
    mutationFn: (choices?: Record<string, string>) => api.relinkImportGit(opId, choices),
    onSuccess: (r) => {
      setResults(r.results);
      toast(t("import.git.relinkDone", { n: r.linked }), "success");
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const open = (results ?? []).filter((r) => r.outcome === "not_linked" || r.outcome === "invalid_choice");
  return (
    <SectionCard title={t("import.git.relinkTitle")} desc={t("import.git.relinkBody")} style={{ padding: 20, maxWidth: 720, marginTop: 16, marginBottom: 0 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn onClick={() => relink.mutate(undefined)} disabled={relink.isPending}>{relink.isPending ? t("import.git.relinking") : t("import.git.relink")}</Btn>
        <a href="/sources" target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
          <Btn variant="ghost">{t("import.git.connectGithub")}</Btn>
        </a>
      </div>
      {results && (
        <ul style={{ margin: "12px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
          {results.map((r) => (
            <li key={r.itemRef} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <span className="mono" style={{ wordBreak: "break-all" }}>{r.name}</span>
              <span style={{ color: r.outcome === "linked" || r.outcome === "already_linked" ? "var(--c-g)" : "var(--c-am)" }}>{t(OUTCOME_KEY[r.outcome])}{r.sourceName ? ` - ${r.sourceName}` : ""}</span>
              {r.candidates && r.candidates.length > 0 && open.some((o) => o.itemRef === r.itemRef) && (
                <>
                  <select aria-label={t("import.git.pickSource")} value={picks[r.itemRef] ?? ""} onChange={(e) => setPicks({ ...picks, [r.itemRef]: e.target.value })} style={{ fontSize: 12 }}>
                    <option value="">{t("import.git.pickSource")}</option>
                    {r.candidates.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <Btn variant="ghost" disabled={!picks[r.itemRef] || relink.isPending} onClick={() => relink.mutate({ [r.itemRef]: picks[r.itemRef] })}>{t("import.git.pickLink")}</Btn>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/** The copy-able PUBLIC deploy key of an ssh repo (shown on the apply timeline). */
export function DeployKeyBlock({ publicKey }: { publicKey: string }) {
  const t = useT();
  return (
    <div style={{ flexBasis: "100%", paddingLeft: 98 }}>
      <div style={{ fontSize: 11, color: "var(--c-am)", marginBottom: 2 }}>{t("import.git.deployKey.title")}</div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "var(--c-sur)", border: "1px solid var(--c-bd)", borderRadius: 8, padding: 8 }}>
        <code className="mono" style={{ flex: 1, fontSize: 11, wordBreak: "break-all", whiteSpace: "pre-wrap" }}>{publicKey}</code>
        <CopyBtn text={publicKey} label={t("import.git.deployKey.copy")} />
      </div>
    </div>
  );
}
