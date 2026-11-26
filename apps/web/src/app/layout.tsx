import "./globals.css";
import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Providers } from "../lib/providers";
import { APPEARANCE_PREPAINT } from "../lib/appearance-script";
import { PwaRegister } from "../components/pwa-register";

export const metadata: Metadata = {
  title: "Tugra",
  description: "Your seal on every server.",
  // The manifest itself is app/manifest.ts (Next links it automatically); these cover iOS home-screen installs.
  // Listing icons here replaces the app/icon.* file links, so the tab icon is named too.
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon.png", type: "image/png", sizes: "256x256" },
    ],
    apple: "/pwa/apple-touch-icon.png",
  },
  appleWebApp: { capable: true, title: "Tugra", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#080809",
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
        <PwaRegister />
      </body>
    </html>
  );
}
