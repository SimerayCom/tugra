"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../i18n/provider";
import { Btn } from "../ui";
import { Field, TextInput } from "../form";
import { memberPinEntries, pinDraftOf, pinRefOf, type PinEntry } from "../../lib/dry-run-decision";
import type { MigrationRunParams } from "../../lib/types";
import { runHintsKey, useRunPlumbing } from "./use-run-actions";

/**
 * The fix of a floating-image warning for the stacks it lists. When the dry run knows the version the source runs for every member
 * (the importer read it from the source's own record), one click pins them all; otherwise a small form asks for the version of
 * each member that has none (a tag other than latest, or a digest) and pins them together. The hub accepts only a version of the
 * same image the source writes.
 */
export function PinFix({ runId, params }: { runId: string; params: MigrationRunParams | undefined }) {
  const t = useT();
  const qc = useQueryClient();
  const { onError, toast } = useRunPlumbing(runId);
  const entries = memberPinEntries(params);
  const known = entries.length > 0 && entries.every((e) => e.seen !== "");
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (pins: Array<{ itemRef: string; member: string; ref: string }>) => api.setMigrationRunServicePins(runId, { pins }),
    onSuccess: (next) => {
      qc.setQueryData(runHintsKey(runId), next);
      setOpen(false);
      toast(t("migrationRun.decision.saved"), "success");
    },
    onError,
  });
  if (entries.length === 0) return null;
  const keyOf = (e: PinEntry) => `${e.itemRef}#${e.member}`;
  const valueOf = (e: PinEntry) => typed[keyOf(e)] ?? pinDraftOf(e.seen);
  const refs = entries.map((e) => ({ e, ref: pinRefOf(e.image, valueOf(e)) }));
  const ready = refs.every((r) => r.ref !== null);

  if (known && !open) {
    // the source shows a version for each member: one click, the way the hub would have read it itself
    return (
      <Btn variant="ghost" loading={save.isPending} onClick={() => save.mutate(entries.map((e) => ({ itemRef: e.itemRef, member: e.member, ref: e.seen })))}>
        {t("migrationRun.decision.fix.pinSource")}
      </Btn>
    );
  }
  if (!open) {
    return (
      <Btn variant="ghost" onClick={() => setOpen(true)}>
        {t("migrationRun.decision.fix.pinVersions")}
      </Btn>
    );
  }
  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        if (ready && !save.isPending) save.mutate(refs.map(({ e, ref }) => ({ itemRef: e.itemRef, member: e.member, ref: ref as string })));
      }}
      style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 420 }}
    >
      {refs.map(({ e, ref }) => {
        const v = valueOf(e);
        return (
          <Field key={keyOf(e)} label={t("migrationRun.decision.pin.versionLabel", { member: e.member })} hint={t("migrationRun.decision.pin.versionHint", { image: e.image })} error={v.trim() !== "" && ref === null ? t("migrationRun.decision.pin.invalid") : undefined}>
            <TextInput value={v} onChange={(ev) => setTyped({ ...typed, [keyOf(e)]: ev.target.value })} placeholder={t("migrationRun.decision.pin.versionPlaceholder")} mono autoComplete="off" spellCheck={false} maxLength={300} style={{ minHeight: 44 }} />
          </Field>
        );
      })}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn type="submit" disabled={!ready} loading={save.isPending}>
          {t("migrationRun.decision.pin.apply")}
        </Btn>
        <Btn variant="ghost" onClick={() => setOpen(false)} disabled={save.isPending}>
          {t("common.cancel")}
        </Btn>
      </div>
    </form>
  );
}
