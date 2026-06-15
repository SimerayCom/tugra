"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Stub } from "../../../components/stub";

function ComingSoon() {
  const params = useSearchParams();
  return <Stub title={params.get("f") ?? "Yakında"} />;
}

export default function ComingSoonPage() {
  return (
    <Suspense fallback={null}>
      <ComingSoon />
    </Suspense>
  );
}
