"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "../../lib/auth";
import { AppShell, CenteredSpinner } from "../../components/shell";

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) return <CenteredSpinner />;
  return <AppShell>{children}</AppShell>;
}
