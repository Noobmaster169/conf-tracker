import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";

import "./globals.css";

const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"], weight: ["400", "500"], display: "swap" });

export const metadata: Metadata = { title: "yt-stream", description: "Live stream ingestor." };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={jetbrains.variable}>
      <body className="min-h-full font-mono text-sm antialiased">{children}</body>
    </html>
  );
}
