import type { ReactNode } from "react";
import { BrandMark, PoweredBy } from "../../components/branding";

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
          <BrandMark size={48} nameSize={28} />
        </div>
        {children}
        <PoweredBy />
      </div>
    </div>
  );
}
