"use client";

import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { AuthProvider } from "./auth";
import { emitToast } from "./toast-bus";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "../components/confirm";
import { ToastProvider } from "../components/toast";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
        // No mutation error is silent: surface it as a toast (inline errors remain).
        mutationCache: new MutationCache({
          onError: (e) => emitToast(e instanceof Error ? e.message : "Something went wrong", "error"),
        }),
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <AuthProvider>{children}</AuthProvider>
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
