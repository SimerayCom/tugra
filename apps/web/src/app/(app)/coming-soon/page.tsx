"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Stub } from "../../../components/stub";
import { useT } from "../../../i18n/provider";

function ComingSoon() {
  const params = useSearchParams();
  const t = useT();
  return <Stub title={params.get("f") ?? t("common.comingSoon")} />;
}

export default function ComingSoonPage() {
  return (
    <Suspense fallback={null}>
      <ComingSoon />
    </Suspense>
  );
}
