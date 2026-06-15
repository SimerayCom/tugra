"use client";

export function Stub({ title }: { title: string }) {
  return (
    <div style={{ padding: 32 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 6px" }}>
        {title}
      </h1>
      <p style={{ color: "var(--c-tx3)", fontSize: 14 }}>
        Bu ekran tasarlandı, yakında bağlanacak. (Designed — wiring coming soon.)
      </p>
    </div>
  );
}
