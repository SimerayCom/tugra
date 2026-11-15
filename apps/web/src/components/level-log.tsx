"use client";

import { useMemo } from "react";
import { logLineLevel } from "../lib/log-lines";

/**
 * Plain-text log body with ERROR/WARN lines tinted (same heuristic as the live container logs).
 * Lines are inline spans ending in a literal newline so selecting + copying the pane yields the
 * original text unchanged.
 */
export function LevelLog({ text }: { text: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  return (
    <>
      {lines.map((line, i) => {
        const level = logLineLevel(line);
        const color = level === "error" ? "var(--c-r)" : level === "warn" ? "var(--c-am)" : undefined;
        const nl = i < lines.length - 1 ? "\n" : "";
        return color ? (
          <span key={i} data-level={level} style={{ color }}>
            {line}
            {nl}
          </span>
        ) : (
          <span key={i}>
            {line}
            {nl}
          </span>
        );
      })}
    </>
  );
}
