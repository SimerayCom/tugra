import "./globals.css";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Providers } from "../lib/providers";

export const metadata = {
  title: "Tugra",
  description: "Your seal on every server.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        {/* Apply the saved theme synchronously, before paint, so a light-mode user doesn't get a dark
            flash on every load (the server can only render a fixed default). "system" resolves against the
            OS here too, so there is no flash in that mode either. Matches useTheme()'s key + resolution. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var p=localStorage.getItem('tugra.theme')||'dark';var t=p==='system'?((window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light'):(p==='light'?'light':'dark');document.documentElement.setAttribute('data-theme',t)}catch(e){}",
          }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
