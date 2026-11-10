import type { Metadata } from "next";
import { cookies } from "next/headers";

// Self-hosted from the package, so the build fetches nothing (SIL OFL 1.1).
import "@fontsource-variable/schibsted-grotesk";
import "./globals.css";

import { parseTheme, THEME_COOKIE } from "@/lib/theme";

export const metadata: Metadata = { title: "Conference Tracker", description: "What is being said on stage, as it is said." };

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // The theme is read on the server, so the first paint is already the reader's choice.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
