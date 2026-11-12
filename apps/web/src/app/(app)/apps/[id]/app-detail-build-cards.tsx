"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import { useToast } from "../../../../components/toast";
import { Btn, SectionCard } from "../../../../components/ui";
import { useUnsavedChanges } from "../../../../hooks/useUnsavedChanges";
import { useT } from "../../../../i18n/provider";
import { api } from "../../../../lib/api";
import { duplicateKeys, invalidKeys } from "../../../../lib/dotenv";
import { gitWebUrls } from "../../../../lib/git-web-url";
import { type AppSource, type BuildType } from "../../../../lib/types";
import { BUILD_TYPE_LABEL, envField, normalizeBaseDir } from "./app-detail-shared";

/** Edit a git-sourced app's watch paths: one glob per line (leading `!` = exclude). Empty = deploy on every
 *  push. When set, only a push that touches a matching file triggers a deploy (monorepo-friendly). */
export function WatchPathsCard({ id, watchPaths }: { id: string; watchPaths: string[] }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState(watchPaths.join("\n"));
  useEffect(() => { setText(watchPaths.join("\n")); }, [watchPaths]);
  const parse = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  const dirty = parse(text).join("\n") !== watchPaths.join("\n");
  const save = useMutation({
    mutationFn: () => api.setAppWatchPaths(id, parse(text)),
    onSuccess: () => { toast(t("apps.saved"), "success"); return qc.invalidateQueries({ queryKey: ["app", id] }); },
    onError: (e) => toast(e instanceof Error ? e.message : t("apps.sourceSaveFailed"), "error"),
  });
  useUnsavedChanges(dirty && !save.isPending);
  return (
    <SectionCard title={t("apps.watchPaths")} desc={t("apps.watchPathsDesc")}>
      <textarea
        className="mono"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        placeholder={"apps/api/**\npackages/shared/**\n!**/*.md"}
        aria-label={t("apps.watchPaths")}
        style={{ width: "100%", minHeight: 96, maxHeight: 240, resize: "vertical", fontSize: 12, lineHeight: 1.5, color: "var(--c-tx)", background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: 10, boxSizing: "border-box" }}
      />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
        <Btn onClick={() => save.mutate()} disabled={save.isPending || !dirty}>{t("apps.save")}</Btn>
      </div>
    </SectionCard>
  );
}

// Edit WHERE the app's code/image comes from, after create. GIT -> repo URL + branch; IMAGE -> image ref.
// (Git credentials themselves live in the Credentials card.) Applies on the next deploy; a host change that
// resets a stored credential is reported back as a warning.
export function SourceCard({ id, source, gitUrl, gitBranch, gitCommit, image, composePath }: { id: string; source: AppSource; gitUrl: string | null; gitBranch: string | null; gitCommit: string | null; image: string | null; composePath: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState(gitUrl ?? "");
  const [branch, setBranch] = useState(gitBranch ?? "");
  const [commit, setCommit] = useState(gitCommit ?? "");
  const [img, setImg] = useState(image ?? "");
  const [path, setPath] = useState(composePath ?? "docker-compose.yml");
  // A COMPOSE-from-git app (composePath set) edits its repo/branch/path here, like a GIT app plus the path.
  const isGitCompose = source === "COMPOSE" && composePath != null;
  const gitLike = source === "GIT" || isGitCompose;
  const dirty = gitLike
    ? url.trim() !== (gitUrl ?? "") || branch.trim() !== (gitBranch ?? "") || commit.trim() !== (gitCommit ?? "") || (isGitCompose && path.trim() !== (composePath ?? ""))
    : img.trim() !== (image ?? "");
  const save = useMutation({
    mutationFn: () =>
      gitLike
        ? api.setAppSource(id, {
            gitUrl: url.trim(),
            ...(branch.trim() ? { gitBranch: branch.trim() } : {}),
            gitCommit: commit.trim() || null, // empty → unpin (deploy branch HEAD); else pin to this SHA
            ...(isGitCompose && path.trim() ? { composePath: path.trim() } : {}),
          })
        : api.setAppSource(id, { image: img.trim() }),
    onSuccess: (res) => {
      for (const w of res.warnings ?? []) toast(t(`apps.sourceWarn_${w}`), "info");
      return qc.invalidateQueries({ queryKey: ["app", id] }); // returned: isPending covers the refetch
    },
    meta: { successMessage: t("apps.saved") },
    onError: (e) => toast(e instanceof Error ? e.message : t("apps.sourceSaveFailed"), "error"),
  });
  useUnsavedChanges(dirty && !save.isPending);

  return (
    <SectionCard title={t("apps.source")} desc={t("apps.sourceDesc")}>
      {gitLike ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input style={{ ...envField, flex: "1 1 320px" }} placeholder={t("apps.sourceGitUrl")} value={url} onChange={(e) => setUrl(e.target.value)} aria-label={t("apps.sourceGitUrl")} />
          <input style={{ ...envField, width: 180 }} placeholder={t("apps.sourceBranch")} value={branch} onChange={(e) => setBranch(e.target.value)} aria-label={t("apps.sourceBranch")} />
          <input className="mono" style={{ ...envField, width: 180 }} placeholder={t("apps.sourceCommit")} value={commit} onChange={(e) => setCommit(e.target.value)} aria-label={t("apps.sourceCommit")} />
          {isGitCompose && (
            <input style={{ ...envField, flex: "1 1 240px" }} placeholder={t("apps.composePath")} value={path} onChange={(e) => setPath(e.target.value)} aria-label={t("apps.composePath")} />
          )}
        </div>
      ) : (
        <input style={{ ...envField, width: "100%" }} placeholder={t("apps.sourceImage")} value={img} onChange={(e) => setImg(e.target.value)} aria-label={t("apps.sourceImage")} />
      )}
      <div style={{ display: "flex", gap: 14, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
        {gitLike && (() => {
          // Links reflect the SAVED source (props), not unsaved edits in the inputs.
          const web = gitWebUrls(gitUrl, gitCommit);
          return (
            <>
              {web.repo && (
                <a href={web.repo} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--c-lapis)" }}>
                  <ExternalLink size={13} aria-hidden /> {t("apps.sourceOpenRepo")}
                </a>
              )}
              {web.commit && (
                <a href={web.commit} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--c-lapis)" }}>
                  <ExternalLink size={13} aria-hidden /> {t("apps.sourceOpenCommit")}
                </a>
              )}
            </>
          );
        })()}
        <div style={{ flex: 1 }} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending || !dirty || (gitLike ? !url.trim() : !img.trim())}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.sourceRedeploy")}</div>}
    </SectionCard>
  );
}

export function BuildSettingsCard({ id, buildType, dockerfilePath, dockerBuildTarget, baseDirectory, buildCommand, outputDir, nixpacksInstallCmd, nixpacksBuildCmd, nixpacksStartCmd }: { id: string; buildType: BuildType; dockerfilePath: string | null; dockerBuildTarget: string | null; baseDirectory: string | null; buildCommand: string | null; outputDir: string | null; nixpacksInstallCmd: string | null; nixpacksBuildCmd: string | null; nixpacksStartCmd: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState<BuildType>(buildType);
  const [dockerfile, setDockerfile] = useState(dockerfilePath ?? "");
  const [target, setTarget] = useState(dockerBuildTarget ?? "");
  const [base, setBase] = useState(baseDirectory ?? "");
  const [cmd, setCmd] = useState(buildCommand ?? "");
  const [out, setOut] = useState(outputDir ?? "");
  const [nixInstall, setNixInstall] = useState(nixpacksInstallCmd ?? "");
  const [nixBuild, setNixBuild] = useState(nixpacksBuildCmd ?? "");
  const [nixStart, setNixStart] = useState(nixpacksStartCmd ?? "");
  const save = useMutation({
    mutationFn: () =>
      api.setAppBuild(id, {
        buildType: type,
        // Always sent (replace semantics): a monorepo base applies to every build type.
        baseDirectory: normalizeBaseDir(base),
        ...(type === "DOCKERFILE" ? { dockerfilePath: dockerfile.trim() || null, dockerBuildTarget: target.trim() || null } : {}),
        ...(type === "STATIC" ? { buildCommand: cmd.trim() || null, outputDir: out.trim() || null } : {}),
        ...(type === "NIXPACKS" ? { nixpacksInstallCmd: nixInstall.trim() || null, nixpacksBuildCmd: nixBuild.trim() || null, nixpacksStartCmd: nixStart.trim() || null } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
    onError: (e) => toast(e instanceof Error ? e.message : t("apps.buildSaveFailed"), "error"),
  });

  return (
    <SectionCard title={t("apps.buildSettings")} desc={t("apps.buildSettingsDesc")}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select style={{ ...envField, width: 200 }} value={type} onChange={(e) => setType(e.target.value as BuildType)} aria-label={t("apps.buildSettings")}>
          {(["NIXPACKS", "DOCKERFILE", "STATIC", "RAILPACK", "HEROKU"] as BuildType[]).map((v) => (
            <option key={v} value={v}>{t(`apps.${BUILD_TYPE_LABEL[v]}`)}</option>
          ))}
        </select>
        {/* Monorepo base directory — applies to every build type, so it sits before the type-specific inputs. */}
        <input style={{ ...envField, flex: "1 1 200px" }} placeholder={t("apps.buildBaseDirectory")} value={base} onChange={(e) => setBase(e.target.value)} aria-label={t("apps.buildBaseDirectory")} />
        {type === "DOCKERFILE" && (
          <>
            <input style={{ ...envField, flex: "1 1 240px" }} placeholder={t("apps.buildDockerfilePath")} value={dockerfile} onChange={(e) => setDockerfile(e.target.value)} aria-label={t("apps.buildDockerfilePath")} />
            <input style={{ ...envField, width: 160 }} placeholder={t("apps.buildTarget")} value={target} onChange={(e) => setTarget(e.target.value)} aria-label={t("apps.buildTarget")} />
          </>
        )}
        {type === "STATIC" && (
          <>
            <input style={{ ...envField, flex: "1 1 240px" }} placeholder={t("apps.buildCommand")} value={cmd} onChange={(e) => setCmd(e.target.value)} aria-label={t("apps.buildCommand")} />
            <input style={{ ...envField, width: 160 }} placeholder={t("apps.outputDir")} value={out} onChange={(e) => setOut(e.target.value)} aria-label={t("apps.outputDir")} />
          </>
        )}
        {type === "NIXPACKS" && (
          <>
            <input style={{ ...envField, flex: "1 1 200px" }} placeholder={t("apps.nixpacksInstallCmd")} value={nixInstall} onChange={(e) => setNixInstall(e.target.value)} aria-label={t("apps.nixpacksInstallCmd")} />
            <input style={{ ...envField, flex: "1 1 200px" }} placeholder={t("apps.nixpacksBuildCmd")} value={nixBuild} onChange={(e) => setNixBuild(e.target.value)} aria-label={t("apps.nixpacksBuildCmd")} />
            <input style={{ ...envField, flex: "1 1 200px" }} placeholder={t("apps.nixpacksStartCmd")} value={nixStart} onChange={(e) => setNixStart(e.target.value)} aria-label={t("apps.nixpacksStartCmd")} />
          </>
        )}
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      {type === "NIXPACKS" && <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "8px 0 0" }}>{t("apps.nixpacksCmdHint")}</p>}
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.sourceRedeploy")}</div>}
    </SectionCard>
  );
}

export function BuildArgsCard({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: args } = useQuery({ queryKey: ["appBuildArgs", id], queryFn: () => api.getAppBuildArgs(id) });
  const [rows, setRows] = useState<{ key: string; value: string }[]>([]);
  useEffect(() => {
    if (args) setRows(Object.entries(args).map(([key, value]) => ({ key, value })));
  }, [args]);

  const save = useMutation({
    mutationFn: () => {
      const map: Record<string, string> = {};
      for (const r of rows) if (r.key.trim()) map[r.key.trim()] = r.value;
      return api.setAppBuildArgs(id, map);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["appBuildArgs", id] });
      qc.invalidateQueries({ queryKey: ["app", id] });
    },
  });
  const setRow = (i: number, patch: Partial<{ key: string; value: string }>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const dups = duplicateKeys(rows);
  const dupSet = new Set(dups);
  const invalid = invalidKeys(rows);

  return (
    <SectionCard title={t("apps.buildArgs")} desc={t("apps.buildArgsDesc")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r, i) => {
          const isDup = !!r.key.trim() && dupSet.has(r.key.trim());
          return (
            <div key={i} style={{ display: "flex", gap: 6 }}>
              <input style={{ ...envField, width: 200, ...(isDup ? { borderColor: "var(--c-r)" } : {}) }} placeholder={t("apps.envKey")} value={r.key} onChange={(e) => setRow(i, { key: e.target.value })} aria-invalid={isDup} aria-label={t("apps.envKey")} />
              <input style={{ ...envField, flex: 1 }} placeholder={t("apps.envValue")} value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} aria-label={t("apps.envValue")} />
              <button aria-label={t("common.remove")} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} style={{ ...envField, cursor: "pointer", color: "var(--c-r)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><X size={14} /></button>
            </div>
          );
        })}
      </div>
      {dups.length > 0 && <div style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{t("apps.envDupWarning", { keys: dups.join(", ") })}</div>}
      {invalid.length > 0 && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envInvalidWarning", { keys: invalid.join(", ") })}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <Btn variant="ghost" onClick={() => setRows((rs) => [...rs, { key: "", value: "" }])}>{t("apps.buildArgsAdd")}</Btn>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => save.mutate()} disabled={save.isPending || dups.length > 0}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.buildArgsRedeploy")}</div>}
    </SectionCard>
  );
}

export function DeploySettingsCard({ id, deployStrategy, rollbackOnFailure, imagesToKeep, postCutoverSoakSec }: { id: string; deployStrategy: string; rollbackOnFailure: boolean; imagesToKeep: number | null; postCutoverSoakSec: number }) {
  const t = useT();
  const qc = useQueryClient();
  const [strategy, setStrategy] = useState<"ROLLING" | "RECREATE">(deployStrategy === "RECREATE" ? "RECREATE" : "ROLLING");
  const [rollback, setRollback] = useState(rollbackOnFailure);
  const [keep, setKeep] = useState(imagesToKeep == null ? "" : String(imagesToKeep)); // blank = default (5)
  const [soak, setSoak] = useState(postCutoverSoakSec ? String(postCutoverSoakSec) : ""); // blank = 0 (off)
  const save = useMutation({
    mutationFn: () => api.setAppDeploySettings(id, { deployStrategy: strategy, rollbackOnFailure: rollback, imagesToKeep: keep.trim() === "" ? null : Number(keep), postCutoverSoakSec: soak.trim() === "" ? 0 : Number(soak) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
  });

  return (
    <SectionCard title={t("apps.deploySettings")} desc={t("apps.deploySettingsDesc")}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select style={{ ...envField, width: 220 }} value={strategy} onChange={(e) => setStrategy(e.target.value as "ROLLING" | "RECREATE")} aria-label={t("apps.deployStrategy")}>
          {(["ROLLING", "RECREATE"] as const).map((v) => (
            <option key={v} value={v}>{t(`apps.deployStrategy_${v}`)}</option>
          ))}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx)" }}>
          <input type="checkbox" checked={rollback} onChange={(e) => setRollback(e.target.checked)} />
          {t("apps.rollbackOnFailure")}
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx)" }}>
          {t("apps.imagesToKeep")}
          <input type="number" min={1} max={20} placeholder="5" style={{ ...envField, width: 72 }} value={keep} onChange={(e) => setKeep(e.target.value)} aria-label={t("apps.imagesToKeep")} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--c-tx)" }}>
          {t("apps.postCutoverSoak")}
          <input type="number" min={0} max={600} placeholder="0" style={{ ...envField, width: 72 }} value={soak} onChange={(e) => setSoak(e.target.value)} aria-label={t("apps.postCutoverSoak")} />
        </label>
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 8 }}>{t("apps.imagesToKeepDesc")}</div>
      <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 8 }}>{t("apps.postCutoverSoakDesc")}</div>
      {!rollback && <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 8 }}>{t("apps.rollbackOnFailureDesc")}</div>}
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
    </SectionCard>
  );
}

export function BuildConfigCard({ id, teamId, registryId, pushToRegistry, buildServerId }: { id: string; teamId: string; registryId: string | null; pushToRegistry: boolean; buildServerId: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: registries = [] } = useQuery({ queryKey: ["registries"], queryFn: () => api.listRegistries() });
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const teamRegistries = registries.filter((r) => r.teamId === teamId);
  const buildServers = servers.filter((s) => s.teamId === teamId && s.status === "ONLINE");
  const [reg, setReg] = useState(registryId ?? "");
  const [push, setPush] = useState(pushToRegistry);
  const [buildServer, setBuildServer] = useState(buildServerId ?? "");
  // A build server needs a registry (the deploy server pulls the image); push is then implied.
  const effectivePush = (push && !!reg) || (!!buildServer && !!reg);
  const save = useMutation({
    mutationFn: () => api.setAppBuildConfig(id, { registryId: reg || null, pushToRegistry: effectivePush, buildServerId: (buildServer && reg) ? buildServer : null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
  });

  return (
    <SectionCard title={t("apps.buildConfig")} desc={t("apps.buildConfigDesc")}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select style={{ ...envField, width: 240 }} value={reg} onChange={(e) => setReg(e.target.value)} aria-label={t("apps.buildRegistry")}>
          <option value="">{t("apps.buildRegistryNone")}</option>
          {teamRegistries.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: reg ? "var(--c-tx)" : "var(--c-tx3)" }}>
          <input type="checkbox" checked={effectivePush} disabled={!reg || !!buildServer} onChange={(e) => setPush(e.target.checked)} />
          {t("apps.pushToRegistry")}
        </label>
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
        <select style={{ ...envField, width: 240 }} value={reg ? buildServer : ""} onChange={(e) => setBuildServer(e.target.value)} disabled={!reg} aria-label={t("apps.buildServer")}>
          <option value="">{t("apps.buildServerNone")}</option>
          {buildServers.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("apps.buildServerHint")}</span>
      </div>
      {teamRegistries.length === 0 && <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 8 }}>{t("apps.buildNoRegistries")}</div>}
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
    </SectionCard>
  );
}

export function ContainerCommandCard({ id, entrypoint, command }: { id: string; entrypoint: string[] | null; command: string[] | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [epText, setEpText] = useState((entrypoint ?? []).join("\n"));
  const [clearEp, setClearEp] = useState(Array.isArray(entrypoint) && entrypoint.length === 0);
  const [cmdText, setCmdText] = useState((command ?? []).join("\n"));
  const parse = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const save = useMutation({
    mutationFn: () => {
      const epArr = parse(epText);
      // Checkbox = reset the image entrypoint with no replacement ([]); otherwise non-empty text, else default.
      const containerEntrypoint = clearEp ? [] : epArr.length ? epArr : null;
      const cmdArr = parse(cmdText);
      return api.setAppContainerCommand(id, { containerEntrypoint, containerCommand: cmdArr.length ? cmdArr : null });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
  });
  const field: React.CSSProperties = { ...envField, width: "100%", boxSizing: "border-box", minHeight: 52, resize: "vertical", fontFamily: "monospace" };
  return (
    <SectionCard title={t("apps.containerCommand")} desc={t("apps.containerCommandDesc")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--c-tx2)" }}>{t("apps.containerEntrypoint")}</span>
          <textarea style={field} placeholder={t("apps.containerCommandPlaceholder")} value={epText} disabled={clearEp} onChange={(e) => setEpText(e.target.value)} />
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "var(--c-tx2)" }}>
          <input type="checkbox" checked={clearEp} onChange={(e) => setClearEp(e.target.checked)} />
          {t("apps.containerEntrypointClear")}
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--c-tx2)" }}>{t("apps.containerCommandArgs")}</span>
          <textarea style={field} placeholder={t("apps.containerCommandPlaceholder")} value={cmdText} onChange={(e) => setCmdText(e.target.value)} />
        </label>
        <div><Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn></div>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.containerCommandRedeploy")}</div>}
    </SectionCard>
  );
}

export function RestartPolicyCard({ id, restartPolicy }: { id: string; restartPolicy: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const POLICIES = ["unless-stopped", "always", "on-failure", "no"] as const;
  const [policy, setPolicy] = useState<string>(restartPolicy ?? "unless-stopped");
  const save = useMutation({
    // "unless-stopped" is the default → store null (keeps the run line byte-identical); else the chosen policy.
    mutationFn: () => api.setAppRestartPolicy(id, policy === "unless-stopped" ? null : policy),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
  });
  const label: Record<string, string> = {
    "unless-stopped": t("apps.restartPolicy_unlessStopped"),
    always: t("apps.restartPolicy_always"),
    "on-failure": t("apps.restartPolicy_onFailure"),
    no: t("apps.restartPolicy_no"),
  };
  return (
    <SectionCard title={t("apps.restartPolicy")} desc={t("apps.restartPolicyDesc")}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <select aria-label={t("apps.restartPolicy")} value={policy} onChange={(e) => setPolicy(e.target.value)} style={{ ...envField, maxWidth: 240 }}>
          {POLICIES.map((p) => (
            <option key={p} value={p}>{label[p]}</option>
          ))}
        </select>
        <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.restartPolicyRedeploy")}</div>}
    </SectionCard>
  );
}

export function ContainerPortCard({ id, containerPort }: { id: string; containerPort: number | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [val, setVal] = useState<string>(String(containerPort ?? 80));
  useEffect(() => setVal(String(containerPort ?? 80)), [containerPort]);
  const n = Number(val);
  const valid = /^\d+$/.test(val.trim()) && Number.isInteger(n) && n >= 1 && n <= 65535;
  const save = useMutation({
    mutationFn: () => api.setAppContainerPort(id, n),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
  });
  return (
    <SectionCard title={t("apps.containerPort")} desc={t("apps.containerPortCardDesc")}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input
          aria-label={t("apps.containerPort")}
          inputMode="numeric"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder="80"
          style={{ ...envField, maxWidth: 160 }}
        />
        <Btn onClick={() => save.mutate()} disabled={save.isPending || !valid}>{t("apps.save")}</Btn>
      </div>
      {!valid && val.trim() !== "" && <div style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{t("apps.containerPortInvalid")}</div>}
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.containerPortRedeploy")}</div>}
    </SectionCard>
  );
}

export function DeployHooksCard({ id, pre, post }: { id: string; pre: string | null; post: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const [preVal, setPreVal] = useState(pre ?? "");
  const [postVal, setPostVal] = useState(post ?? "");
  const save = useMutation({
    mutationFn: () => api.setAppDeployHooks(id, { preDeployCommand: preVal.trim() || null, postDeployCommand: postVal.trim() || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id] }),
    meta: { successMessage: t("apps.saved") },
  });
  const field: React.CSSProperties = { ...envField, width: "100%", boxSizing: "border-box", minHeight: 52, resize: "vertical" };
  return (
    <SectionCard title={t("apps.deployHooks")} desc={t("apps.deployHooksDesc")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--c-tx2)" }}>{t("apps.preDeployCommand")}</span>
          <textarea style={field} placeholder={t("apps.preDeployPlaceholder")} value={preVal} onChange={(e) => setPreVal(e.target.value)} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--c-tx2)" }}>{t("apps.postDeployCommand")}</span>
          <textarea style={field} placeholder={t("apps.postDeployPlaceholder")} value={postVal} onChange={(e) => setPostVal(e.target.value)} />
        </label>
        <div><Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn></div>
      </div>
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.deployHooksRedeploy")}</div>}
    </SectionCard>
  );
}

export function CredentialsCard({
  id,
  source,
  gitUrl,
  composePath,
  hasGitToken,
  hasGitSshKey,
  gitSshPublicKey,
  registryUrl,
  registryUser,
}: {
  id: string;
  source: string;
  gitUrl: string | null;
  composePath: string | null;
  hasGitToken: boolean;
  hasGitSshKey: boolean;
  gitSshPublicKey: string | null;
  registryUrl: string | null;
  registryUser: string | null;
}) {
  const t = useT();
  const qc = useQueryClient();
  // A GIT build OR a git-sourced COMPOSE app both clone a repo → both manage a deploy key / git token here.
  const isGit = source === "GIT" || (source === "COMPOSE" && composePath != null);
  // An ssh:// / git@ repo authenticates with a deploy key, not a token.
  const sshRepo = isGit && !!gitUrl && /^(ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(gitUrl);
  const [gitToken, setGitToken] = useState("");
  const [url, setUrl] = useState(registryUrl ?? "");
  const [user, setUser] = useState(registryUser ?? "");
  const [token, setToken] = useState("");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["app", id] });
  const save = useMutation({
    mutationFn: () =>
      api.setAppCredentials(
        id,
        isGit
          ? { gitToken: gitToken.trim() || null }
          : { registry: user.trim() && token.trim() ? { url: url.trim() || undefined, user: user.trim(), token } : null },
      ),
    onSuccess: () => { setGitToken(""); setToken(""); invalidate(); },
  });
  const genKey = useMutation({ mutationFn: () => api.generateGitSshKey(id), onSuccess: invalidate });
  const rmKey = useMutation({ mutationFn: () => api.removeGitSshKey(id), onSuccess: invalidate });

  return (
    <SectionCard title={t("apps.credentials")} desc={t("apps.credentialsDesc")}>
      {sshRepo ? (
        gitSshPublicKey ? (
          <div>
            <p style={{ fontSize: 12, color: "var(--c-tx2)", margin: "0 0 6px" }}>{t("apps.deployKeyHint")}</p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input readOnly value={gitSshPublicKey} onFocus={(e) => e.currentTarget.select()} aria-label={t("apps.deployKey")} style={{ ...envField, flex: 1, minWidth: 200, fontFamily: "monospace", fontSize: 11 }} />
              <Btn variant="ghost" onClick={() => navigator.clipboard?.writeText(gitSshPublicKey).catch(() => {})}>{t("apps.copy")}</Btn>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <Btn variant="ghost" onClick={() => genKey.mutate()} disabled={genKey.isPending}>{t("apps.deployKeyRegen")}</Btn>
              <Btn variant="dangerGhost" onClick={() => rmKey.mutate()} disabled={rmKey.isPending}>{t("apps.deployKeyRemove")}</Btn>
            </div>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 12, color: "var(--c-tx3)", margin: "0 0 8px" }}>{t("apps.deployKeyNone")}</p>
            <Btn onClick={() => genKey.mutate()} disabled={genKey.isPending}>{t("apps.deployKeyGenerate")}</Btn>
            {genKey.isError && <div style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{(genKey.error as Error).message}</div>}
          </div>
        )
      ) : isGit ? (
        <div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              style={{ ...envField, flex: 1, minWidth: 200 }}
              type="password"
              placeholder={hasGitToken ? t("apps.gitTokenSet") : t("apps.gitToken")}
              value={gitToken}
              onChange={(e) => setGitToken(e.target.value)}
              aria-label={t("apps.gitToken")}
            />
            <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
          </div>
          <p style={{ fontSize: 11, color: "var(--c-tx3)", margin: "6px 0 0" }}>{t("apps.gitTokenHint")}</p>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input style={{ ...envField, width: 200 }} placeholder={t("apps.registryUrl")} value={url} onChange={(e) => setUrl(e.target.value)} aria-label={t("apps.registryUrl")} />
          <input style={{ ...envField, width: 150 }} placeholder={t("apps.registryUser")} value={user} onChange={(e) => setUser(e.target.value)} aria-label={t("apps.registryUser")} />
          <input style={{ ...envField, flex: 1, minWidth: 160 }} type="password" placeholder={t("apps.registryToken")} value={token} onChange={(e) => setToken(e.target.value)} aria-label={t("apps.registryToken")} />
          <Btn onClick={() => save.mutate()} disabled={save.isPending}>{t("apps.save")}</Btn>
        </div>
      )}
      {save.isSuccess && <div style={{ fontSize: 12, color: "var(--c-am)", marginTop: 8 }}>{t("apps.envRedeploy")}</div>}
    </SectionCard>
  );
}
