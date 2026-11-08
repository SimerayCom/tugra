"use client";

import { useCallback, useEffect, useId, useRef } from "react";
import { useRouter } from "next/navigation";
import { useT } from "../i18n/provider";
import { useOptionalConfirm } from "../components/confirm";

/**
 * Unsaved-changes leave guard.
 *
 * Config cards save independently and already track their own `dirty` flag; they call
 * `useUnsavedChanges(dirty)` and this module aggregates them in a registry (any dirty card => guard on):
 *  - a native `beforeunload` prompt covers reload / tab close / external navigation;
 *  - a document-level capture click handler intercepts in-app link clicks (Next `<Link>` / `<a>`) and asks
 *    through the existing confirm dialog before letting the navigation proceed;
 *  - `useLeaveGuard()` wraps programmatic switches (the detail-page tab strip) the same way;
 *  - `useGuardedPush()` is the same guard around `router.push` (⌘K palette, clickable rows).
 * Listeners exist only while something is dirty, are installed in effects (SSR-safe) and removed on clean/unmount.
 * Browser back/forward is not interceptable in the App Router; `beforeunload` is the only net there.
 */

const dirtyIds = new Set<string>();
let installed = false;
let bypass = false; // true while we re-dispatch a click the user already confirmed
let suppressUnload = false; // the user just confirmed leaving; don't double-prompt a full page load
let prompting = false;
let latestAsk: (() => Promise<boolean>) | null = null;

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (suppressUnload || dirtyIds.size === 0) return;
  e.preventDefault();
  e.returnValue = ""; // required by some browsers to show the native prompt
}

/** The in-app link a click would follow, or null if it isn't a plain same-origin page navigation. */
function navigationAnchor(e: MouseEvent): HTMLAnchorElement | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const el = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!(el instanceof HTMLAnchorElement)) return null;
  if ((el.target && el.target !== "_self") || el.hasAttribute("download")) return null;
  let url: URL;
  try { url = new URL(el.href, window.location.href); } catch { return null; }
  if (url.origin !== window.location.origin) return null; // external: beforeunload handles it
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return null; // API downloads/endpoints don't leave the page
  if (url.pathname === window.location.pathname && url.search === window.location.search) return null; // same page / hash jump
  return el;
}

function onClickCapture(e: MouseEvent) {
  if (bypass || dirtyIds.size === 0 || !latestAsk) return;
  const a = navigationAnchor(e);
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  if (prompting) return;
  prompting = true;
  const ask = latestAsk;
  void ask().then((ok) => {
    prompting = false;
    if (!ok) return;
    // Re-dispatch the same click so the framework's own navigation (Next <Link>) runs untouched.
    bypass = true;
    suppressUnload = true;
    setTimeout(() => { suppressUnload = false; }, 1000);
    try { a.click(); } finally { bypass = false; }
  });
}

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("beforeunload", onBeforeUnload);
  document.addEventListener("click", onClickCapture, true);
}

function uninstall() {
  if (!installed || typeof window === "undefined") return;
  installed = false;
  window.removeEventListener("beforeunload", onBeforeUnload);
  document.removeEventListener("click", onClickCapture, true);
}

/** Ask the user whether to leave; uses the app confirm dialog when mounted, `window.confirm` otherwise. */
function useAskLeave(): () => Promise<boolean> {
  const t = useT();
  const confirm = useOptionalConfirm();
  return useCallback(async () => {
    const body = t("common.leaveUnsavedBody");
    if (confirm) {
      return confirm({
        title: t("common.leaveUnsavedTitle"),
        body,
        confirmLabel: t("common.leaveUnsavedConfirm"),
        cancelLabel: t("common.leaveUnsavedStay"),
        danger: true,
      });
    }
    return typeof window !== "undefined" ? window.confirm(body) : true;
  }, [t, confirm]);
}

/** Register a card's dirty flag. Pass `dirty && !saving`; a clean card never prompts. */
export function useUnsavedChanges(dirty: boolean): void {
  const id = useId();
  const ask = useAskLeave();
  const askRef = useRef(ask);
  askRef.current = ask;

  useEffect(() => {
    if (!dirty) return;
    dirtyIds.add(id);
    latestAsk = () => askRef.current();
    install();
    return () => {
      dirtyIds.delete(id);
      if (dirtyIds.size === 0) {
        uninstall();
        latestAsk = null;
      }
    };
  }, [dirty, id]);
}

/** True while any registered card has unsaved edits. */
export function hasUnsavedChanges(): boolean {
  return dirtyIds.size > 0;
}

/**
 * For programmatic navigation (tab switches): `guard(go)` runs `go` immediately when nothing is dirty,
 * otherwise only after the user confirms leaving.
 */
export function useLeaveGuard(): (go: () => void) => void {
  const ask = useAskLeave();
  return useCallback(
    (go: () => void) => {
      if (dirtyIds.size === 0) { go(); return; }
      void ask().then((ok) => { if (ok) go(); });
    },
    [ask],
  );
}

/**
 * `router.push` behind the leave guard: pushes immediately when nothing is dirty, otherwise only after the
 * user confirms. Use for programmatic navigations that can fire from a page with editable config (⌘K, rows).
 */
export function useGuardedPush(): (href: string) => void {
  const router = useRouter();
  const guard = useLeaveGuard();
  return useCallback((href: string) => guard(() => router.push(href)), [guard, router]);
}
