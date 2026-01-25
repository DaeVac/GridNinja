import { redirect } from "next/navigation";
import { auth0 } from "@/lib/auth0";
import DigitalTwinDashboard from "../components/DigitalTwinDashboard";

export default async function Page() {
  const session = await auth0.getSession();

  if (!session?.user) {
    redirect("/");
  }

  return <DigitalTwinDashboard />;
}
