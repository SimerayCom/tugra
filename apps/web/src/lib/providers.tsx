"use client";

import { MutationCache, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { PollingQueryClient } from "./idle-polling";
import { AuthProvider } from "./auth";
import { emitToast } from "./toast-bus";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "../components/confirm";
import { ToastProvider } from "../components/toast";
import { TeamScopeProvider } from "../components/team-scope";
import { BrandingProvider } from "../components/branding";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new PollingQueryClient({
        defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
        // No mutation error is silent: surface it as a toast (inline errors remain). A mutation can also
        // OPT IN to a success toast by setting meta.successMessage — so a save gives feedback without each
        // card wiring its own useToast (and without toasting every lifecycle mutation).
        mutationCache: new MutationCache({
          onError: (e) => emitToast(e instanceof Error ? e.message : "Something went wrong", "error"),
          onSuccess: (_data, _vars, _ctx, mutation) => {
            const msg = mutation.meta?.successMessage;
            if (typeof msg === "string" && msg) emitToast(msg, "success");
          },
        }),
      }),
  );
  // One shared idle/active tracker for every polled query: 4x slower after 60 s without interaction, instant refetch on return.
  useEffect(() => client.start(), [client]);
  return (
    <QueryClientProvider client={client}>
      <BrandingProvider>
        <I18nProvider>
          <ToastProvider>
            <ConfirmProvider>
              <AuthProvider>
                <TeamScopeProvider>{children}</TeamScopeProvider>
              </AuthProvider>
            </ConfirmProvider>
          </ToastProvider>
        </I18nProvider>
      </BrandingProvider>
    </QueryClientProvider>
  );
}
