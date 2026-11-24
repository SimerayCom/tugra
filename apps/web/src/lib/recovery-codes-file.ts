/**
 * Saving two-factor recovery codes outside the app: a .txt download and a print sheet. Pure builders (unit-
 * tested) plus two tiny DOM helpers. Labels arrive as parameters so every user-visible string stays in the
 * locale files. Nothing here talks to the network; the codes never leave the browser.
 */

export interface RecoveryCodesFileInput {
  codes: string[];
  /** The hub's address as the owner sees it, e.g. `https://hub.acme.test`. */
  origin: string;
  now: Date;
  /** Localized lines written into the file. */
  labels: { title: string; hub: string; created: string; hint: string };
}

/** `tugra-recovery-codes-<host>-<yyyy-mm-dd>.txt`; the host is reduced to filename-safe characters. */
export function recoveryCodesFilename(origin: string, now: Date): string {
  let host = origin;
  try {
    host = new URL(origin).host;
  } catch {
    /* keep the raw value, sanitised below */
  }
  const safeHost = host.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "hub";
  return `tugra-recovery-codes-${safeHost}-${now.toISOString().slice(0, 10)}.txt`;
}

export function buildRecoveryCodesFile(i: RecoveryCodesFileInput): { filename: string; text: string } {
  const text = [i.labels.title, "", `${i.labels.hub}: ${i.origin}`, `${i.labels.created}: ${i.now.toISOString()}`, "", ...i.codes, "", i.labels.hint, ""].join("\n");
  return { filename: recoveryCodesFilename(i.origin, i.now), text };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A small self-contained print sheet (monospace codes, hub + date on top). */
export function buildRecoveryCodesPrintHtml(i: RecoveryCodesFileInput): string {
  const items = i.codes.map((c) => `<li>${escapeHtml(c)}</li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(i.labels.title)}</title><style>
body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#000}
h1{font-size:18px;margin:0 0 8px}
p{margin:2px 0;color:#333}
ul{list-style:none;padding:0;margin:20px 0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 24px}
li{font:16px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.04em}
</style></head><body><h1>${escapeHtml(i.labels.title)}</h1><p>${escapeHtml(i.labels.hub)}: ${escapeHtml(i.origin)}</p><p>${escapeHtml(i.labels.created)}: ${escapeHtml(i.now.toISOString())}</p><ul>${items}</ul><p>${escapeHtml(i.labels.hint)}</p></body></html>`;
}

/** Hand `text` to the browser as a file download. */
export function downloadTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Print an HTML document through a throw-away hidden iframe (no popup, so no popup blocker). */
export function printHtml(html: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  frame.onload = () => {
    const w = frame.contentWindow;
    if (w) {
      w.focus();
      w.print();
    }
    setTimeout(() => frame.remove(), 1000);
  };
  frame.srcdoc = html;
  document.body.appendChild(frame);
}
