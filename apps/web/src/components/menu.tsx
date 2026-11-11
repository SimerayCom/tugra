"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type FocusEvent } from "react";
import { Ellipsis, type LucideIcon } from "lucide-react";
import { useDismiss } from "../lib/use-dismiss";

export interface MenuItem {
  key: string;
  label: string;
  icon?: LucideIcon;
  /** Icon tint matching Btn.iconTone, so a lifecycle action reads at a glance. */
  tone?: "success" | "warn" | "danger";
  /** Red label for a destructive action. */
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
}

/**
 * Accessible overflow ("…") menu. A single hand-rolled copy of this lived in the app- and database-detail
 * headers with no keyboard support; this primitive implements the ARIA menu-button pattern:
 *  - trigger: aria-haspopup="menu" + aria-expanded + aria-controls; ArrowDown/Up open (first/last item)
 *  - open focuses the first item; ArrowUp/Down roam with wraparound, Home/End jump
 *  - disabled items are aria-disabled but stay FOCUSABLE (so their "why" title is reachable, and live
 *    disabled flags never drop focus to <body>); activating one is a no-op
 *  - Enter/Space select (native button click); Escape and Tab close and return focus to the trigger
 *  - outside pointer-down (useDismiss) and focus leaving the menu (onBlur) both close it
 * Items carry their own icon/tone/danger; the menu owns only open state and focus.
 */
export function Menu({
  items,
  label,
  align = "end",
  size = 16,
}: {
  items: MenuItem[];
  /** Accessible name for the trigger and the menu. */
  label: string;
  /** Which edge the popover aligns to (default: right/end). */
  align?: "start" | "end";
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Latest items/length read without making the open-effect depend on the (new-every-render) array.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // ArrowUp on the trigger opens onto the LAST item; everything else opens onto the first.
  const openToLast = useRef(false);
  const menuId = useId();

  useDismiss(open, wrapRef, () => setOpen(false));

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  // On open, move focus to the first (or last, for ArrowUp) item.
  useEffect(() => {
    if (!open) return;
    const n = itemsRef.current.length;
    if (n === 0) return;
    const idx = openToLast.current ? n - 1 : 0;
    openToLast.current = false;
    setActiveIdx(idx);
    itemRefs.current[idx]?.focus();
  }, [open]);

  const move = (dir: 1 | -1 | "home" | "end") => {
    const n = items.length;
    if (n === 0) return;
    const next = dir === "home" ? 0 : dir === "end" ? n - 1 : (activeIdx + dir + n) % n;
    setActiveIdx(next);
    itemRefs.current[next]?.focus();
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); move(1); break;
      case "ArrowUp": e.preventDefault(); move(-1); break;
      case "Home": e.preventDefault(); move("home"); break;
      case "End": e.preventDefault(); move("end"); break;
      // Keep Escape from also closing a parent modal, then hand focus back to the trigger.
      case "Escape": e.preventDefault(); e.stopPropagation(); close(true); break;
      // Close and return focus to the trigger, but let the browser's own Tab then move on from there.
      case "Tab": close(true); break;
      default: break;
    }
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); openToLast.current = false; setOpen(true); }
    else if (e.key === "ArrowUp") { e.preventDefault(); openToLast.current = true; setOpen(true); }
  };

  // Close when focus leaves the menu entirely (programmatic focus move, SR virtual cursor, etc.), without
  // stealing focus. Selecting / Esc / Tab already move focus to the trigger (inside the wrapper), so this
  // never fights them.
  const onWrapBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (open && !wrapRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
  };

  const select = (it: MenuItem) => {
    if (it.disabled) return;
    close(true);
    it.onSelect();
  };

  const toneColor = (tone?: string) =>
    tone === "success" ? "var(--c-g)" : tone === "warn" ? "var(--c-am)" : tone === "danger" ? "var(--c-r)" : undefined;

  // An empty menu would be invalid ARIA (role=menu with no menuitems); render nothing.
  if (items.length === 0) return null;

  return (
    <div ref={wrapRef} onBlur={onWrapBlur} style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={triggerRef}
        type="button"
        className="tg-iconbtn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(true) : setOpen(true))}
        onKeyDown={onTriggerKeyDown}
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 6, borderRadius: "var(--r1)", cursor: "pointer", fontFamily: "inherit", fontSize: 14, lineHeight: 1 }}
      >
        <Ellipsis size={size} aria-hidden />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: align === "end" ? 0 : undefined,
            left: align === "start" ? 0 : undefined,
            zIndex: 20,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            padding: 6,
            minWidth: 180,
            background: "var(--c-el)",
            border: "1px solid var(--c-bd)",
            borderRadius: "var(--r1)",
            boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
          }}
        >
          {items.map((it, i) => (
            <button
              key={it.key}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={i === activeIdx ? 0 : -1}
              aria-disabled={it.disabled || undefined}
              title={it.title}
              onClick={() => select(it)}
              onFocus={() => setActiveIdx(i)}
              className="tg-menuitem"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                textAlign: "left",
                padding: "7px 10px",
                border: "1px solid transparent",
                borderRadius: "var(--r1)",
                color: it.danger ? "var(--c-r)" : "var(--c-tx)",
                font: "inherit",
                fontSize: 13,
                fontWeight: 500,
                cursor: it.disabled ? "default" : "pointer",
                opacity: it.disabled ? 0.5 : 1,
              }}
            >
              {it.icon && <it.icon size={14} aria-hidden style={{ flexShrink: 0, color: it.danger ? "var(--c-r)" : toneColor(it.tone) }} />}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
