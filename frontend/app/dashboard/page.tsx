// app/dashboard/page.tsx
import { withPageAuthRequired } from "@auth0/nextjs-auth0";

export default withPageAuthRequired(function Dashboard() {
  return (
    <div className="dashboard-page">
      <h1>Welcome to the Dashboard</h1>
      <p>You are successfully logged in.</p>
    </div>
  );
});