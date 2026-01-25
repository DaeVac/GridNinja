import { auth0 } from "@/lib/auth0";
import { redirect } from "next/navigation";
import DashboardView from "../components/DashboardView";

export default async function DashboardPage() {
  const session = await auth0.getSession();

  if (!session || !session.user) {
    redirect("/");
  }

  return <DashboardView user={session.user} />;
}