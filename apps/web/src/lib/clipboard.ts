/**
 * Copy text to the clipboard, honestly. `navigator.clipboard` only exists in a SECURE context
 * (https or localhost); on Tugra's bare-IP quick-start (http://<ip>:<port>) it is `undefined`, so a
 * naive `navigator.clipboard?.writeText(...)` silently no-ops while the UI still says "Copied". This
 * tries the async Clipboard API first, then falls back to a hidden-textarea + `document.execCommand`
 * (which works on insecure origins), and returns whether the copy actually succeeded so the caller can
 * show a truthful toast.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // permission denied / not focused / insecure origin — fall through to the execCommand fallback
  }
  try {
    if (typeof document === "undefined") return false;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // keep it off-screen and non-scrolling so selecting it doesn't jump the page
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
