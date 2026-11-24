"use client";

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CloudUpload, Trash2, type LucideIcon } from "lucide-react";
import { useT } from "../i18n/provider";
import { cropToPngBase64, suggestColorFromImage } from "../lib/icon";
import { Btn, Card } from "./ui";
import { useToast } from "./toast";
import { EntityTile } from "./entity-identity";
import { EntityColorPicker } from "./entity-color-picker";

export interface IdentityLabels {
  hint: string;
  upload: string;
  replace: string;
  remove: string;
  uploaded: string;
  removed: string;
  tooLarge: string;
  readFailed: string;
  failed: string;
}

/**
 * Icon + colour card shared by team and project settings. The browser centre-crops an upload to a small PNG
 * (shrinking to fit the 64KB cap), and in parallel reads the image's dominant colour so the picker can offer
 * it as a one-click suggestion. Colour changes save immediately.
 */
export function IdentityCard({
  name, iconUrl, color, canEdit, fallbackIcon: Fallback, labels, onSaveIcon, onRemoveIcon, onSaveColor, onChanged,
}: {
  name: string;
  iconUrl: string | null;
  color: string | null;
  canEdit: boolean;
  fallbackIcon: LucideIcon;
  labels: IdentityLabels;
  onSaveIcon: (pngBase64: string) => Promise<unknown>;
  onRemoveIcon: () => Promise<unknown>;
  onSaveColor: (color: string | null) => Promise<unknown>;
  onChanged: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

  const save = useMutation({
    mutationFn: (data: string) => onSaveIcon(data),
    onSuccess: () => { onChanged(); toast(labels.uploaded, "success"); },
    onError: (e) => toast(errMsg(e, labels.failed), "error"),
  });
  const remove = useMutation({
    mutationFn: () => onRemoveIcon(),
    onSuccess: () => { setSuggestion(null); onChanged(); toast(labels.removed, "success"); },
    onError: (e) => toast(errMsg(e, labels.failed), "error"),
  });
  const setColor = useMutation({
    mutationFn: (c: string | null) => onSaveColor(c),
    onSuccess: () => { setSuggestion(null); onChanged(); toast(t("identity.colorSaved"), "success"); },
    onError: (e) => toast(errMsg(e, t("identity.colorFailed")), "error"),
  });

  const onPick = async (file: File) => {
    setProcessing(true);
    try {
      let data = "";
      for (const side of [128, 96, 64]) {
        data = await cropToPngBase64(file, side);
        if (data.length * 0.75 <= 64 * 1024) break;
      }
      if (data.length * 0.75 > 64 * 1024) { toast(labels.tooLarge, "error"); return; }
      const suggested = await suggestColorFromImage(file);
      await save.mutateAsync(data).then(() => setSuggestion(suggested), () => undefined);
    } catch {
      toast(labels.readFailed, "error");
    } finally {
      setProcessing(false);
    }
  };

  const busy = processing || save.isPending || remove.isPending;
  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <EntityTile color={color} size={48} radius={12} iconUrl={iconUrl} bordered fallback={<Fallback size={22} color="currentColor" aria-hidden />} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{name}</div>
          <div style={{ fontSize: 12, color: "var(--c-tx3)" }}>{labels.hint}</div>
        </div>
        {canEdit && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="ghost" icon={CloudUpload} onClick={() => fileRef.current?.click()} disabled={busy} loading={busy}>
              {iconUrl ? labels.replace : labels.upload}
            </Btn>
            {iconUrl && <Btn variant="ghost" icon={Trash2} onClick={() => remove.mutate()} disabled={busy}>{labels.remove}</Btn>}
          </div>
        )}
      </div>
      {canEdit && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--c-bd)" }}>
          <EntityColorPicker
            value={color}
            onChange={(c) => setColor.mutate(c)}
            suggestion={suggestion}
            onDismissSuggestion={() => setSuggestion(null)}
            disabled={setColor.isPending}
            previewLabel={name}
          />
        </div>
      )}
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void onPick(f); }} />
    </Card>
  );
}
