import { redirect } from "next/navigation";

/** The Monitor is the front page now; an old link lands there. */
export default function MonitorPage() {
  redirect("/");
}
