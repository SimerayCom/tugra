"use client";

import { X } from "lucide-react";
import { useT } from "../i18n/provider";
import { useConfirm } from "./confirm";
import { IconBtn } from "./icon-btn";

/**
 * Remove-a-row control shared across the multi-row config cards. A freshly-added, unsaved row
 * removes on the first click; a row that mirrors saved config (`confirm`) asks first, so a real,
 * live mapping isn't dropped by a stray click. The caller applies the removal in `onRemove`.
 */
export function RowRemoveButton({
  label,
  onRemove,
  confirm = false,
  confirmTitle,
  confirmBody,
  disabled,
}: {
  label: string;
  onRemove: () => void;
  confirm?: boolean;
  confirmTitle?: string;
  confirmBody?: string;
  disabled?: boolean;
}) {
  const t = useT();
  const ask = useConfirm();
  const click = async () => {
    if (confirm) {
      const ok = await ask({ title: confirmTitle ?? t("common.confirmTitle"), body: confirmBody, danger: true, confirmLabel: t("common.remove") });
      if (!ok) return;
    }
    onRemove();
  };
  return (
    <IconBtn label={label} danger disabled={disabled} onClick={click}>
      <X size={14} />
    </IconBtn>
  );
}
