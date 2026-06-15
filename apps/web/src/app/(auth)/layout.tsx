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
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: "var(--c-a)",
              color: "#0d0d11",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 800,
            }}
          >
            T
          </div>
          <span style={{ fontWeight: 700, fontSize: 18 }}>Tugra</span>
        </div>
        {children}
      </div>
    </div>
  );
}
