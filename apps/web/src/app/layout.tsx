import "./globals.css";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Providers } from "../lib/providers";
import { APPEARANCE_PREPAINT } from "../lib/appearance-script";

export const metadata = {
  title: "Tugra",
  description: "Your seal on every server.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      data-ui-scale="100"
      data-page-width="full"
      data-nav-style="default"
      data-ui-style="flat"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        {/* Apply the saved appearance (theme incl. system/custom, UI scale, page width, nav style, style)
            synchronously, before paint, so a reload never flashes the defaults the server renders. Keys and
            values match lib/appearance.ts; the script lives in lib/appearance-script.ts (pinned by a test). */}
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_PREPAINT }} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
