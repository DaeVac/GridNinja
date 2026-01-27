import { redirect } from "next/navigation";
import { auth0Configured, getSessionSafe } from "@/lib/auth0";
import DigitalTwinDashboard from "../components/DigitalTwinDashboard";

export default async function Page() {
  const session = await getSessionSafe();

  if (auth0Configured && !session?.user) {
    redirect("/");
  }

  return <DigitalTwinDashboard />;
}
