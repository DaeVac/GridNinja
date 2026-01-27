import { redirect } from "next/navigation";
import { auth0Configured, getSessionSafe } from "@/lib/auth0";
import DashboardView from "../components/DashboardView";

export default async function DashboardPage() {
  const session = await getSessionSafe();

  if (auth0Configured && !session?.user) {
    redirect("/");
  }

  const user = session?.user ?? {
    name: "Local Dev",
    picture: "/tempLogo.svg",
    email: "local@gridninja.dev",
  };

  return <DashboardView user={user} />;
}
