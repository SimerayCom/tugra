"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { CopyBtn } from "../copy-row";
import { MoreInfo } from "../help-link";
import { failureKey, readyToTest, testLineParts } from "../../lib/import-connect";
import { guideUrl } from "../../lib/help-links";
import type { ImportConnectFailureCode, ImportRemoteKind, ImportTestResult } from "../../lib/types";

const DEBOUNCE_MS = 700;

export type TestState = { status: "idle" } | { status: "testing" } | { status: "done"; result: ImportTestResult };

/**
 * Tests the token once a URL has been confirmed (the field was left) and a token is filled (debounced, once per distinct pair),
 * so the person sees one line about it instead of reading rules first. A half-typed address never receives the token.
 * Nothing is stored. A newer pair always wins over a slower, older answer.
 * `onResult` fires for each finished test (the wizard uses it to fill the source team label).
 */
export function useConnectionTest(args: { kind: ImportRemoteKind; teamId: string; baseUrl: string; urlConfirmed: boolean; token: string; onResult?: (r: ImportTestResult) => void }): TestState {
  const { kind, teamId, baseUrl, token, urlConfirmed } = args;
  const [state, setState] = useState<TestState>({ status: "idle" });
  const seq = useRef(0);
  const onResult = useRef(args.onResult);
  onResult.current = args.onResult;

  useEffect(() => {
    const mine = ++seq.current;
    // A CapRover password is never tried while it is typed: every try is a login, and a half-typed one is a failed login on their server.
    if (kind === "caprover" || !teamId || !urlConfirmed || !readyToTest(baseUrl, token)) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "testing" });
    const timer = setTimeout(async () => {
      let result: ImportTestResult;
      try {
        result = await api.importTest({ sourceKind: kind, teamId, baseUrl: baseUrl.trim(), token: token.trim() });
      } catch (e) {
        result = { ok: false, code: "other", message: e instanceof Error ? e.message : "" };
      }
      if (seq.current !== mine) return;
      setState({ status: "done", result });
      onResult.current?.(result);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [kind, teamId, baseUrl, token, urlConfirmed]);

  return state;
}

/** Where to put this hub into Coolify's Allowed IPs, one line. Only ever rendered after Coolify named the IP list as the cause. */
function EgressIpNote() {
  const t = useT();
  const { data, isError, isPending } = useQuery({ queryKey: ["import-egress-ip"], queryFn: () => api.importEgressIp(), staleTime: 5 * 60_000, retry: false });
  if (isPending) return null;
  return (
    <div data-testid="egress-ip" style={{ background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", padding: "10px 12px", margin: "8px 0 0", fontSize: 12 }}>
      {isError ? (
        <p style={{ margin: 0, color: "var(--c-tx3)" }}>{t("import.egressIp.unavailable")}</p>
      ) : data?.ip ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <span style={{ color: "var(--c-tx2)" }}>{t("import.egressIp.known")}</span>
          <code className="mono" style={{ fontSize: 13, userSelect: "all", wordBreak: "break-all" }}>{data.ip}</code>
          <CopyBtn text={data.ip} label={t("import.egressIp.copy")} />
        </div>
      ) : (
        <p style={{ margin: 0, color: "var(--c-tx2)" }}>{t("import.egressIp.unknown")}</p>
      )}
      {!isError && (
        <MoreInfo style={{ margin: "6px 0 0" }}>
          {data?.ip && <p style={{ margin: "0 0 4px" }}>{data.source === "env" ? t("import.egressIp.knownEnv") : t("import.egressIp.knownServer")}</p>}
          <p style={{ margin: 0 }}>{t("import.egressIp.proxy")}</p>
        </MoreInfo>
      )}
    </div>
  );
}

/** What the connection test (or a refused connect) says, in one line, and only the help that fits the cause. */
export function ConnectionStatus({ test, connectError, source, kind }: { test: TestState; connectError: Error | null; source: string; kind?: ImportRemoteKind }) {
  const t = useT();

  // A refused connect speaks for itself (its code is the hub's); otherwise the test's answer.
  if (connectError) {
    const code = (connectError instanceof ApiError ? connectError.code : undefined) as ImportConnectFailureCode | undefined;
    return <Failure code={code} message={connectError.message} source={source} kind={kind} />;
  }
  if (test.status === "idle") return null;
  if (test.status === "testing") {
    return <p role="status" style={lineStyle("var(--c-tx3)")}>{t("import.test.checking")}</p>;
  }
  const r = test.result;
  if (!r.ok) return <Failure code={r.code} message={r.message} source={source} kind={kind} />;

  const parts = testLineParts(r);
  const counts = parts.counts.map((c) => t(`import.test.${c.key}_${c.n === 1 ? "one" : "other"}`, { n: c.n }));
  const head = parts.hasTeam ? t("import.test.okTeam", { team: r.team ?? "" }) : t("import.test.ok", { source });
  const tail = parts.sensitive === null ? [] : [parts.sensitive ? t("import.test.sensitiveYes") : t("import.test.sensitiveNo")];
  const line = [[head, ...counts].join(t("import.test.sepCounts")), ...tail].join(t("import.test.sepFacts"));
  return (
    <div data-testid="connection-test">
      <p role="status" style={lineStyle(parts.sensitive === false ? "var(--c-am)" : "var(--c-g)")}>{line}</p>
      {parts.sensitive === false && <p style={{ ...lineStyle("var(--c-tx3)"), marginTop: 2 }}>{t("import.test.sensitiveNote")}</p>}
    </div>
  );
}

function Failure({ code, message, source, kind }: { code: ImportConnectFailureCode | undefined; message: string; source: string; kind?: ImportRemoteKind }) {
  const t = useT();
  return (
    <div data-testid="connection-failure">
      <div role="alert" style={lineStyle("var(--c-r)")}>{t(failureKey(code, kind), { source })}</div>
      {code === "allowed-ips" && <EgressIpNote />}
      {message && (
        <MoreInfo label={t("import.test.details")} style={{ margin: "2px 0 12px" }}>
          <p style={{ margin: "0 0 6px", overflowWrap: "anywhere" }}>{message}</p>
          <a href={guideUrl(kind === "caprover" ? "move-from-caprover" : "move-from-coolify")} target="_blank" rel="noopener noreferrer" style={{ color: "var(--c-lapis)" }}>{t("import.test.guide")}</a>
        </MoreInfo>
      )}
    </div>
  );
}

const lineStyle = (color: string): React.CSSProperties => ({ fontSize: 12, color, margin: "-6px 0 12px", overflowWrap: "anywhere", lineHeight: 1.5 });
