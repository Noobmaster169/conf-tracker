import type { Metadata } from "next";

// Self-hosted from the package, so the build fetches nothing (SIL OFL 1.1).
import "@fontsource-variable/schibsted-grotesk";
import "./globals.css";

export const metadata: Metadata = { title: "Conference Tracker", description: "What is being said on stage, as it is said." };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
