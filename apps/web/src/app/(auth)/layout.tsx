import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{ width: 380, maxWidth: "100%" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            justifyContent: "center",
            marginBottom: 24,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/tugra-logo.svg" alt="Tugra" width={48} height={48} />
          <span style={{ fontWeight: 700, fontSize: 28, letterSpacing: "-0.01em" }}>Tugra</span>
        </div>
        {children}
      </div>
    </div>
  );
}
