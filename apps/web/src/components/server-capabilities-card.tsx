"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { ServerView } from "../lib/types";
import { useT } from "../i18n/provider";
import { Btn, SectionCard } from "./ui";

/** Every capability a server can be granted, in display order. `files_write` is only meaningful on top of `files`. */
export const CAPABILITIES = ["deploy", "database", "backup", "cleanup", "bulk", "terminal", "schedule", "patch", "logs", "files", "files_write", "swarm"];

/** Capabilities that carry a one-line explanation under their label (they widen what the agent can touch). */
const WITH_DESC = new Set(["files", "files_write"]);

/**
 * Toggle one capability in a set. Unchecking `files` also unchecks `files_write` (write without read is not a
 * grantable state), and `files_write` can only be turned ON while `files` is on.
 */
export function toggleCapability(prev: ReadonlySet<string>, c: string): Set<string> {
  const n = new Set(prev);
  if (n.has(c)) {
    n.delete(c);
    if (c === "files") n.delete("files_write");
  } else if (c !== "files_write" || n.has("files")) {
    n.add(c);
  }
  return n;
}

export function CapabilitiesCard({ id, server }: { id: string; server: ServerView }) {
  const t = useT();
  const qc = useQueryClient();
  // The checked set IS the granted set: what's ticked is exactly what the hub may do. An empty
  // grant means "nothing allowed" (fail-safe) — unchecking everything revokes, never grants.
  // A `files` grant made through the API is already in server.capabilities, so it shows checked and is preserved.
  const [caps, setCaps] = useState<Set<string>>(() => new Set(server.capabilities));
  useEffect(() => {
    setCaps(new Set(server.capabilities));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);
  const toggle = (c: string) => setCaps((prev) => toggleCapability(prev, c));
  const save = useMutation({
    mutationFn: () => api.setServerCapabilities(id, [...caps]),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["server", id] }),
  });
  return (
    <SectionCard title={t("servers.capabilities")} desc={t("servers.capabilitiesDesc")} style={{ marginTop: 20 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
        {CAPABILITIES.map((c) => (
          <label key={c} style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 13, color: "var(--c-tx2)", maxWidth: 320 }}>
            <input
              type="checkbox"
              checked={caps.has(c)}
              disabled={c === "files_write" && !caps.has("files")}
              onChange={() => toggle(c)}
              style={{ marginTop: 2 }}
            />
            <span>
              {t(`servers.cap_${c}`)}
              {WITH_DESC.has(c) && <span style={{ display: "block", fontSize: 11, color: "var(--c-tx3)", lineHeight: 1.4 }}>{t(`servers.cap_${c}_desc`)}</span>}
            </span>
          </label>
        ))}
      </div>
      <Btn variant="ghost" onClick={() => save.mutate()} disabled={save.isPending}>{t("servers.save")}</Btn>
      {save.isSuccess && <span style={{ fontSize: 12, color: "var(--c-g)", marginLeft: 10 }}>{t("servers.capsSaved")}</span>}
    </SectionCard>
  );
}
