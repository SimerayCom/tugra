"use client";

import { useState } from "react";
import { MessageSquare } from "lucide-react";
import { useT } from "../i18n/provider";
import { Btn, Card } from "./ui";
import { FeedbackModal } from "./feedback-modal";

/** Settings entry point for the opt-in feedback flow. Not owner-gated — anyone can report a problem.
 *  Opens the modal; nothing is sent until the user acts there. */
export function FeedbackCard() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{t("feedback.cardTitle")}</div>
      <p style={{ fontSize: 13, color: "var(--c-tx2)", margin: "0 0 14px", lineHeight: 1.5 }}>{t("feedback.cardBody")}</p>
      <Btn icon={MessageSquare} variant="ghost" onClick={() => setOpen(true)}>{t("feedback.open")}</Btn>
      {open && <FeedbackModal onClose={() => setOpen(false)} />}
    </Card>
  );
}
