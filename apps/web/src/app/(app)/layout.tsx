"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "../../lib/auth";
import { uiMode, isHomeAllowed } from "../../lib/ui-mode";
import { AppShell, CenteredSpinner } from "../../components/shell";

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  // Home mode keeps the user on the simplified surface; fleet routes reached by
  // URL or ⌘K redirect back to the launcher.
  useEffect(() => {
    if (!loading && user && uiMode(user.uiMode) === "home" && !isHomeAllowed(pathname)) {
      router.replace("/home");
    }
  }, [loading, user, pathname, router]);

  if (loading || !user) return <CenteredSpinner />;
  return <AppShell>{children}</AppShell>;
}
