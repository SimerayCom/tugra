"use client";

import { useState } from "react";
import { Wand2 } from "lucide-react";
import { useT } from "../i18n/provider";
import { Btn } from "./ui";
import { Modal } from "./modal";
import { ProjectPicker, type ProjectChoice } from "./project-picker";
import type { BulkOp } from "../lib/import-mapping";

type OpKind = "prefix" | "suffix" | "replace" | "lowercase" | "move" | "exclude" | "include" | "reset";
const OPS: OpKind[] = ["prefix", "suffix", "replace", "lowercase", "move", "exclude", "include", "reset"];

const input: React.CSSProperties = { width: "100%", minHeight: 44, padding: "8px 10px", fontSize: 14, background: "var(--c-el)", border: "1px solid var(--c-bd)", borderRadius: "var(--r1)", color: "var(--c-tx)", fontFamily: "inherit", boxSizing: "border-box" };

/** A bulk-edit button + sheet. "Apply to all" does not store a rule: the caller expands the action into explicit
 *  per-row edits (what you see is what is saved). On narrow screens the sheet sits at the bottom. */
export function ImportBulkBar({ count, onApply, label, projects = [] }: { count: number; onApply: (op: BulkOp) => void; label?: string; /** What the "Move to project" picker offers. */ projects?: ProjectChoice[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<OpKind>("prefix");
  const [text, setText] = useState("");
  const [find, setFind] = useState("");
  const [withText, setWith] = useState("");
  const [project, setProject] = useState("");
  const [environment, setEnvironment] = useState("");

  const run = () => {
    const op: BulkOp =
      kind === "prefix" ? { type: "prefix", text }
      : kind === "suffix" ? { type: "suffix", text }
      : kind === "replace" ? { type: "replace", find, with: withText }
      : kind === "move" ? { type: "move", project, environment }
      : { type: kind };
    onApply(op);
    setOpen(false);
  };
  const narrow = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 640px)").matches;
  const valid = kind === "prefix" || kind === "suffix" ? text.length > 0 : kind === "replace" ? find.length > 0 : kind === "move" ? project.trim().length > 0 : true;

  return (
    <>
      <Btn variant="ghost" icon={Wand2} onClick={() => setOpen(true)} disabled={count === 0}>
        {label ?? t("import.review.bulk.open")}
      </Btn>
      {open && (
        <Modal onClose={() => setOpen(false)} width={460} ariaLabel={t("import.review.bulk.title")} backdropStyle={narrow ? { alignItems: "flex-end", padding: 0 } : undefined} cardStyle={narrow ? { width: "100%", maxWidth: "100%", borderRadius: "var(--r2) var(--r2) 0 0" } : undefined}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("import.review.bulk.title")}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)", marginBottom: 12 }}>{t("import.review.bulk.for", { count })}</div>
          <label htmlFor="imp-bulk-op" style={{ display: "block", fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("import.review.bulk.op")}</label>
          <select id="imp-bulk-op" style={{ ...input, marginBottom: 12 }} value={kind} onChange={(e) => setKind(e.target.value as OpKind)}>
            {OPS.map((o) => (
              <option key={o} value={o}>{t(`import.review.bulk.${o}`)}</option>
            ))}
          </select>
          {(kind === "prefix" || kind === "suffix") && (
            <>
              <label htmlFor="imp-bulk-text" style={{ display: "block", fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("import.review.bulk.text")}</label>
              <input id="imp-bulk-text" style={{ ...input, marginBottom: 12 }} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} />
            </>
          )}
          {kind === "replace" && (
            <>
              <label htmlFor="imp-bulk-find" style={{ display: "block", fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("import.review.bulk.find")}</label>
              <input id="imp-bulk-find" style={{ ...input, marginBottom: 12 }} value={find} onChange={(e) => setFind(e.target.value)} autoComplete="off" spellCheck={false} />
              <label htmlFor="imp-bulk-with" style={{ display: "block", fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("import.review.bulk.with")}</label>
              <input id="imp-bulk-with" style={{ ...input, marginBottom: 12 }} value={withText} onChange={(e) => setWith(e.target.value)} autoComplete="off" spellCheck={false} />
            </>
          )}
          {kind === "move" && (
            <>
              <label htmlFor="imp-bulk-project" style={{ display: "block", fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("import.review.bulk.project")}</label>
              <div style={{ marginBottom: 12 }}>
                <ProjectPicker id="imp-bulk-project" value={project} projects={projects} onChange={setProject} />
              </div>
              <label htmlFor="imp-bulk-env" style={{ display: "block", fontSize: 12, color: "var(--c-tx3)", marginBottom: 4 }}>{t("import.review.bulk.environment")}</label>
              <input id="imp-bulk-env" style={{ ...input, marginBottom: 12 }} value={environment} onChange={(e) => setEnvironment(e.target.value)} autoComplete="off" spellCheck={false} />
            </>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Btn variant="ghost" onClick={() => setOpen(false)}>{t("import.review.bulk.close")}</Btn>
            <Btn onClick={run} disabled={!valid}>{t("import.review.bulk.applyToAll")}</Btn>
          </div>
        </Modal>
      )}
    </>
  );
}
