"use client";

import { useId, type KeyboardEvent } from "react";

/**
 * A one-line explanation for a label ("Seal", ...): a small "i" button whose text shows on hover and on keyboard focus
 * (tap focuses it too), wired with aria-describedby so a screen reader reads it with the button. Esc hides it.
 * `label` names the button for assistive tech ("About Seal"); `text` is the explanation itself.
 */
export function InfoTip({ label, text }: { label: string; text: string }) {
  const id = useId();
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Escape") e.currentTarget.blur();
  };
  return (
    <span className="tg-tip">
      <button type="button" className="tg-tip-btn" aria-label={label} aria-describedby={id} onKeyDown={onKeyDown}>
        <span aria-hidden>i</span>
      </button>
      <span role="tooltip" id={id} className="tg-tip-bubble">
        {text}
      </span>
    </span>
  );
}
