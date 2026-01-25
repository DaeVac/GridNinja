// import { auth0 } from "@/lib/auth0";
import { redirect } from "next/navigation";
import DashboardView from "../components/DashboardView";

export default async function DashboardPage() {
  // const session = await auth0.getSession();

  // if (!session || !session.user) {
  //   redirect("/");
  // }

  const user = {
    name: "Demo User",
    email: "demo@gridninja.ai",
    picture: "https://cdn.auth0.com/avatars/de.png",
  };

  return <DashboardView user={user} />;
}
