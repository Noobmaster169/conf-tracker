import { Nav } from "@/components/nav";

/** Every page behind the login shares the bar; the login page stands alone. */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <Nav />
      {children}
    </>
  );
}
