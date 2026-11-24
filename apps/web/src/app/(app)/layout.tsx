"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { isPortalAllowed, isPortalOnly } from "../../lib/portal";
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

  // The instance requires 2FA for owners/admins and this account hasn't enrolled: the hub confines the session to
  // account self-service, so send the user to the setup screen instead of a shell full of 403s.
  useEffect(() => {
    if (!loading && user?.twoFaSetupRequired) router.replace("/two-factor-setup");
  }, [loading, user, router]);

  // Home mode keeps the user on the simplified surface; fleet routes reached by
  // URL or ⌘K redirect back to the launcher.
  useEffect(() => {
    if (!loading && user && uiMode(user.uiMode) === "home" && !isHomeAllowed(pathname)) {
      router.replace("/home");
    }
  }, [loading, user, pathname, router]);

  // A customer account (a Client of a team, nothing of its own) lives on the portal: everything else redirects there.
  const { data: teams } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams(), enabled: !!user, staleTime: 60_000 });
  const portalOnly = !!teams && isPortalOnly(teams);
  useEffect(() => {
    if (portalOnly && !isPortalAllowed(pathname)) router.replace("/portal");
  }, [portalOnly, pathname, router]);

  if (loading || !user) return <CenteredSpinner />;
  if (portalOnly && !isPortalAllowed(pathname)) return <CenteredSpinner />;
  if (user.twoFaSetupRequired) return <CenteredSpinner />; // redirecting → /two-factor-setup
  // Don't MOUNT a fleet page (and fire its queries) for a Home user who landed off-route — the effect above
  // is redirecting to /home; show the spinner until it does, instead of flashing fleet content.
  if (uiMode(user.uiMode) === "home" && !isHomeAllowed(pathname)) return <CenteredSpinner />;
  return <AppShell>{children}</AppShell>;
}
