import { translate } from "../../i18n/translate";
import en from "../../i18n/locales/en";

/**
 * The page the service worker shows when a navigation cannot reach the network. A server component on purpose: it is
 * plain HTML with no data and no auth, so the one copy the worker keeps is safe to store and works without any script.
 */
export default function OfflinePage() {
  const t = (key: string) => translate(en as Record<string, unknown>, key);
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: "var(--page-pad, 24px)",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{t("pwa.offlineTitle")}</h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14, margin: 0, maxWidth: 360 }}>{t("pwa.offlineBody")}</p>
      {/* A plain link (a full reload), so it works with no script. */}
      <a
        href="/"
        style={{
          marginTop: 8,
          display: "inline-flex",
          alignItems: "center",
          minHeight: 44,
          padding: "0 20px",
          borderRadius: "var(--r1)",
          background: "var(--c-a)",
          color: "#14141a",
          fontWeight: 600,
          fontSize: 14,
          textDecoration: "none",
        }}
      >
        {t("pwa.offlineRetry")}
      </a>
    </main>
  );
}
