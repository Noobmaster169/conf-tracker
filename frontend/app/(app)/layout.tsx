import { cookies } from "next/headers";

import { Nav } from "@/components/nav";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";

/** Every page shares the bar, public and admin alike; the login page stands alone. */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <>
      <Nav theme={theme} />
      {children}
    </>
  );
}
