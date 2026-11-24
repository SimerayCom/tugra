"use client";

import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useT } from "../../../i18n/provider";
import { useToast } from "../../../components/toast";
import { Btn } from "../../../components/ui";
import { Field, Select, TextInput } from "../../../components/form";
import { draftFromChannel, parseTopics, toggleIn, type RoutingDraft } from "../../../lib/notification-routing";
import type { Channel } from "../../../lib/types";

/** The routing vocabulary served by the hub (GET /channels/events) — nothing is hardcoded here. */
export interface RoutingVocab {
  categories: string[];
  severities: string[];
}

const tapRow = { display: "flex", alignItems: "center", gap: 10, minHeight: 44, fontSize: 14, color: "var(--c-tx2)", cursor: "pointer" } as const;

/**
 * Which alerts a channel gets: category checkboxes + a minimum level, and (behind "More") a Telegram topic
 * per category with an optional per-category test. Controlled — the parent owns the draft and what Save does.
 */
export function RoutingEditor({
  idPrefix,
  vocab,
  draft,
  onChange,
  telegram,
  onTestCategory,
  testing,
  extra,
}: {
  idPrefix: string;
  vocab: RoutingVocab;
  draft: RoutingDraft;
  onChange: (d: RoutingDraft) => void;
  telegram: boolean;
  /** Present only for a saved channel: sends a test as that category. */
  onTestCategory?: (category: string) => void;
  testing?: string | null;
  /** Extra "More" content (the create form puts its individual-event list here). */
  extra?: ReactNode;
}) {
  const t = useT();
  const [more, setMore] = useState(false);
  const label = (cat: string) => t(`notifications.category_${cat}`);
  const showMore = telegram || !!onTestCategory || !!extra;
  const selected = vocab.categories.filter((c) => draft.categories.includes(c));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <fieldset style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
        <legend style={{ fontSize: 12, fontWeight: 600, color: "var(--c-tx2)", padding: 0, marginBottom: 4 }}>{t("notifications.routeTitle")}</legend>
        <div style={{ display: "flex", flexWrap: "wrap", columnGap: 20 }}>
          {vocab.categories.map((cat) => (
            <label key={cat} style={tapRow}>
              <input type="checkbox" checked={draft.categories.includes(cat)} onChange={() => onChange({ ...draft, categories: toggleIn(draft.categories, cat) })} />
              {label(cat)}
            </label>
          ))}
        </div>
        {draft.categories.includes("uptime") && <div style={{ fontSize: 12, color: "var(--c-tx3)", marginTop: 2 }}>{t("notifications.uptimeNote")}</div>}
      </fieldset>

      <Field label={t("notifications.level")} htmlFor={`${idPrefix}-level`} style={{ maxWidth: 320 }}>
        <Select
          id={`${idPrefix}-level`}
          value={draft.minSeverity}
          onChange={(v) => onChange({ ...draft, minSeverity: v })}
          options={vocab.severities.map((s) => ({ value: s, label: t(`notifications.severity_${s}`) }))}
        />
      </Field>

      {showMore && (
        <div>
          <button
            type="button"
            aria-expanded={more}
            aria-controls={`${idPrefix}-more`}
            onClick={() => setMore((m) => !m)}
            style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--c-tx3)", fontSize: 13, padding: 0, minHeight: 44, fontFamily: "inherit" }}
          >
            {more ? "▾" : "▸"} {more ? t("notifications.less") : t("notifications.more")}
          </button>
          {/* Always in the DOM (hidden attr, not conditional) so field state and tests survive a collapse. */}
          <div id={`${idPrefix}-more`} hidden={!more}>
            {(telegram || onTestCategory) && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {telegram && <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{t("notifications.topicHint")}</div>}
                {selected.map((cat) => (
                  <div key={cat} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minHeight: 44 }}>
                    <span style={{ flex: "1 1 96px", fontSize: 14, color: "var(--c-tx2)" }}>{label(cat)}</span>
                    {telegram && (
                      <TextInput
                        inputMode="numeric"
                        aria-label={`${label(cat)} — ${t("notifications.topic")}`}
                        placeholder={t("notifications.topic")}
                        value={draft.topics[cat] ?? ""}
                        onChange={(e) => onChange({ ...draft, topics: { ...draft.topics, [cat]: e.target.value } })}
                        style={{ width: 130 }}
                      />
                    )}
                    {onTestCategory && (
                      <Btn
                        variant="ghost"
                        aria-label={t("notifications.testCategory", { category: label(cat) })}
                        onClick={() => onTestCategory(cat)}
                        loading={testing === cat}
                        disabled={!!testing}
                      >
                        {t("notifications.test")}
                      </Btn>
                    )}
                  </div>
                ))}
              </div>
            )}
            {extra}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Inline routing editor for a saved channel: edits categories / level / topics, saves them with one PUT,
 * and sends a per-category test through the same transport as real alerts.
 */
export function ChannelRoutingPanel({ channel, vocab, onClose }: { channel: Channel; vocab: RoutingVocab; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<RoutingDraft>(() => draftFromChannel(channel));
  const [error, setError] = useState("");
  const telegram = channel.type === "telegram";

  const save = useMutation({
    mutationFn: () => {
      const { topics, invalid } = parseTopics(draft.topics, draft.categories);
      if (invalid.length) throw new Error(t("notifications.topicInvalid"));
      return api.updateChannel(channel.id, {
        categories: draft.categories,
        minSeverity: draft.minSeverity,
        ...(telegram ? { topics: Object.keys(topics).length ? topics : null } : {}),
      });
    },
    onSuccess: () => {
      setError("");
      qc.invalidateQueries({ queryKey: ["channels"] });
      toast(t("notifications.routingSaved"), "success");
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });
  const test = useMutation({
    mutationFn: (category: string) => api.testChannel(channel.id, category),
    onSuccess: () => toast(t("notifications.testSentTo", { name: channel.name }), "success"),
    onError: (e) => setError(`${t("notifications.testFailed")}: ${(e as Error).message}`),
  });

  return (
    <div style={{ width: "100%", borderTop: "1px solid var(--c-bd)", paddingTop: 12 }}>
      <RoutingEditor
        idPrefix={`route-${channel.id}`}
        vocab={vocab}
        draft={draft}
        onChange={setDraft}
        telegram={telegram}
        onTestCategory={(c) => test.mutate(c)}
        testing={test.isPending ? test.variables : null}
      />
      {error && <div role="alert" style={{ fontSize: 12, color: "var(--c-r)", marginTop: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <Btn onClick={() => save.mutate()} loading={save.isPending}>{t("common.save")}</Btn>
        <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
      </div>
    </div>
  );
}
