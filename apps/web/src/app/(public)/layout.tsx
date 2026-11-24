import type { ReactNode } from "react";
import { PoweredBy } from "../../components/branding";

/** Unauthenticated pages (the public status page). No sidebar and no session redirect: anyone with the link can read. */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <main style={{ minHeight: "100vh", display: "flex", justifyContent: "center", padding: "32px 16px" }}>
      <div style={{ width: 720, maxWidth: "100%" }}>
        {children}
        <PoweredBy style={{ marginTop: 32 }} />
      </div>
    </main>
  );
}
