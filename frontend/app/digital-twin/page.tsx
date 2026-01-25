import { redirect } from "next/navigation";
import { auth0, hasAuth0Config } from "@/lib/auth0";
import DigitalTwinDashboard from "../components/DigitalTwinDashboard";

export default async function Page() {
  const session = await auth0.getSession();

  if (hasAuth0Config && !session?.user) {
    redirect("/");
  }

  return <DigitalTwinDashboard />;
}
