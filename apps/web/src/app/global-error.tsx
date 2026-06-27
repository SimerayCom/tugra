"use client";

// Catastrophic boundary: replaces the root layout, so it has no Providers/i18n.
// Keep it self-contained (own <html>/<body>, fixed English, theme via globals.css).
import "./globals.css";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" data-theme="dark">
      <body>
        <div style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>Something went wrong</div>
          <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: 0, maxWidth: 420 }}>
            The app hit an unexpected error. Reloading usually fixes it.
          </p>
          <button
            onClick={() => reset()}
            style={{ background: "var(--c-a)", color: "#0d0d11", fontWeight: 600, fontSize: 14, padding: "9px 16px", borderRadius: "var(--r1)", border: "none", cursor: "pointer", fontFamily: "inherit" }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
