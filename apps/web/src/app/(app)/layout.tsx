"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "../../lib/auth";
import { uiMode, isHomeAllowed } from "../../lib/ui-mode";
import { AppShell, CenteredSpinner } from "../../components/shell";

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, loading, initialized } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // A fresh install (no owner yet) sends the visitor to onboarding instead of a pointless login page.
    if (!loading && !user) router.replace(initialized === false ? "/welcome" : "/login");
  }, [loading, user, initialized, router]);

  // Home mode keeps the user on the simplified surface; fleet routes reached by
  // URL or ⌘K redirect back to the launcher.
  useEffect(() => {
    if (!loading && user && uiMode(user.uiMode) === "home" && !isHomeAllowed(pathname)) {
      router.replace("/home");
    }
  }, [loading, user, pathname, router]);

  if (loading || !user) return <CenteredSpinner />;
  // Don't MOUNT a fleet page (and fire its queries) for a Home user who landed off-route — the effect above
  // is redirecting to /home; show the spinner until it does, instead of flashing fleet content.
  if (uiMode(user.uiMode) === "home" && !isHomeAllowed(pathname)) return <CenteredSpinner />;
  return <AppShell>{children}</AppShell>;
}
