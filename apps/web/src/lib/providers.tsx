"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { AuthProvider } from "./auth";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "../components/confirm";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <I18nProvider>
        <ConfirmProvider>
          <AuthProvider>{children}</AuthProvider>
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
