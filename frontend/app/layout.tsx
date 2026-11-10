import type { Metadata } from "next";
import localFont from "next/font/local";

import "./globals.css";

// Self-hosted, so the build makes no network call: next/font/google's build-time fetch failed on Vercel.
// The latin subset of JetBrains Mono's variable font (SIL OFL 1.1), as Google Fonts serves it.
const jetbrains = localFont({ src: "./fonts/jetbrains-mono-latin.woff2", variable: "--font-jetbrains", weight: "100 800", display: "swap" });

export const metadata: Metadata = { title: "conf-tracker", description: "Live conference claim tracker." };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={jetbrains.variable}>
      <body className="min-h-full font-mono text-sm antialiased">{children}</body>
    </html>
  );
}
