"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { autoServerId, installableServers } from "../lib/install";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";
import { Field, Select, TextInput } from "./form";
import { Modal } from "./modal";
import { TemplateLogo } from "../lib/template-icons";
import { useToast } from "./toast";
import type { Template } from "../lib/types";

/** Home-mode one-tap install: name + (auto) server → create app + best-effort deploy → launcher. */
export function InstallModal({ template, onClose }: { template: Template; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const qc = useQueryClient();

  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const online = installableServers(servers);
  const [name, setName] = useState(template.name);
  const [serverId, setServerId] = useState("");
  // Servers load async; auto-pick the sole online server once they arrive.
  useEffect(() => {
    if (!serverId) {
      const auto = autoServerId(servers);
      if (auto) setServerId(auto);
    }
  }, [servers, serverId]);

  const install = useMutation({
    // One call: the server creates the app and kicks off a best-effort deploy, so
    // the modal returns immediately instead of waiting on the build.
    mutationFn: async () => api.createFromTemplate(template.slug, { name: name.trim(), serverId, deploy: true }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["apps"] });
      toast(t("home.installed", { name: name.trim() }), "success");
      router.push("/home");
    },
  });

  const canInstall = !!name.trim() && !!serverId && !install.isPending;

  return (
    <Modal onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span style={{ width: 40, height: 40, borderRadius: 10, background: "var(--c-el)", border: "1px solid var(--c-bd)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <TemplateLogo logo={template.logo} slug={template.slug} name={template.name} size={24} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>{t("home.installTitle", { name: template.name })}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", overflow: "hidden", textOverflow: "ellipsis" }}>{template.description}</div>
        </div>
      </div>

      {online.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--c-tx3)", lineHeight: 1.5 }}>
          {t("home.noServer")}{" "}
          <Link href="/servers/new" style={{ color: "var(--c-lapis)" }}>{t("home.connectServer")}</Link>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label={t("home.appName")} htmlFor="install-name">
            <TextInput id="install-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {online.length > 1 && (
            <Field label={t("home.chooseServer")} htmlFor="install-server">
              <Select
                id="install-server"
                value={serverId}
                onChange={setServerId}
                options={online.map((s) => ({ value: s.id, label: s.name }))}
              />
            </Field>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
        <Btn onClick={() => install.mutate()} disabled={!canInstall || online.length === 0}>
          {install.isPending ? t("home.installing") : t("home.install")}
        </Btn>
      </div>
    </Modal>
  );
}
