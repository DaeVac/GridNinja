import { redirect } from "next/navigation";
import { auth0, hasAuth0Config } from "@/lib/auth0";
import DashboardView from "../components/DashboardView";

export default async function DashboardPage() {
  const session = await auth0.getSession();

  if (hasAuth0Config && !session?.user) {
    redirect("/");
  }

  const user = session?.user ?? {
    name: "Dev Operator",
    email: "dev@gridninja.ai",
    picture: "https://cdn.auth0.com/avatars/de.png",
  };

  return <DashboardView user={user} />;
}
