"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { useToast } from "../toast";
import { Spinner } from "../ui";
import { isGithubInstallUrl } from "../../lib/github-manifest";

/** Where GitHub sends the browser back. `manifest`: the App was created (`code`, `state`) → store it, then go install.
 *  `install`: the App was installed (`installation_id`, `state`) → record it and return to Git Sources. The ticket is
 *  single use, so the effect runs once even under React strict mode. */
export function GithubReturn({ mode }: { mode: "manifest" | "install" }) {
  return (
    <Suspense fallback={<div style={{ padding: "var(--page-pad)" }}><Spinner /></div>}>
      <Inner mode={mode} />
    </Suspense>
  );
}

function Inner({ mode }: { mode: "manifest" | "install" }) {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const ran = useRef(false);
  const [state, setState] = useState<"working" | "done" | "error" | "nothing">("working");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const stateParam = params.get("state") ?? "";
    const code = params.get("code") ?? "";
    const installationId = params.get("installation_id") ?? "";
    if (!stateParam || (mode === "manifest" ? !code : !installationId)) {
      setState("nothing");
      return;
    }
    (async () => {
      try {
        if (mode === "manifest") {
          const r = await api.completeGithubManifest({ code, state: stateParam });
          await qc.invalidateQueries({ queryKey: ["gitSources"] });
          setState("done");
          if (isGithubInstallUrl(r.installUrl)) window.location.assign(r.installUrl);
        } else {
          const s = await api.captureGithubInstallation({ state: stateParam, installationId });
          await qc.invalidateQueries({ queryKey: ["gitSources"] });
          toast(t("sources.connectedToast", { name: s.name }), "success");
          setState("done");
          router.replace("/sources");
        }
      } catch (e) {
        setMessage((e as Error).message);
        setState("error");
      }
    })();
  }, [params, mode, qc, router, toast, t]);

  const title = mode === "manifest" ? t("sources.returnTitleManifest") : t("sources.returnTitleInstall");
  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 560 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 12px" }}>{title}</h1>
      {state === "working" && <Spinner />}
      {state === "done" && <p role="status" style={{ color: "var(--c-tx2)", fontSize: 14 }}>{mode === "manifest" ? t("sources.returnOkManifest") : t("sources.returnOkInstall")}</p>}
      {(state === "error" || state === "nothing") && (
        <>
          <p role="alert" style={{ color: state === "error" ? "var(--c-r)" : "var(--c-tx2)", fontSize: 14, margin: "0 0 8px" }}>
            {state === "nothing" ? t("sources.returnNothing") : t("sources.returnError")}
          </p>
          {state === "error" && message && <p style={{ color: "var(--c-tx3)", fontSize: 12, margin: "0 0 12px", overflowWrap: "anywhere" }}>{message}</p>}
          <Link href="/sources" className="tg-btn" style={{ display: "inline-flex", alignItems: "center", minHeight: 44, padding: "0 14px", color: "var(--c-a)" }}>{t("sources.returnBack")}</Link>
        </>
      )}
    </div>
  );
}
