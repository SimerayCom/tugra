"use client";

import { useParams } from "next/navigation";
import { RunDetail } from "../../../../../components/migration-run/run-detail";

export default function MigrationRunPage() {
  const id = String(useParams().id);
  return (
    <div style={{ padding: "var(--page-pad)", maxWidth: 1100, margin: "0 auto" }}>
      <RunDetail id={id} />
    </div>
  );
}
