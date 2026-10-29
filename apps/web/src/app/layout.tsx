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
            flash on every load (the server can only render a fixed default). Matches useTheme()'s key. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('tugra.theme')||'dark';document.documentElement.setAttribute('data-theme',t)}catch(e){}",
          }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
