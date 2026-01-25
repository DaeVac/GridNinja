<<<<<<< HEAD
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
=======
"use client";

import React from "react";
import { withPageAuthRequired } from "@auth0/nextjs-auth0";
import { KpiGrid } from "@/components/kpi/KpiGrid";
import { KpiCardProps } from "@/components/kpi/KpiCard";
import { DollarSign, ShieldAlert, Leaf, Zap } from "lucide-react";

const DashboardPage = () => {
  const isPending = false;

  const kpis: KpiCardProps[] = [
    {
      title: "Money Saved",
      value: 12450.2,
      format: "currency",
      decimals: 0,
      subtitle: "vs baseline (last 24h)",
      footnote: "Savings from carbon-aware shifting + peak avoidance.",
      delta: 0.12,
      deltaFormat: "percent",
      status: "allowed",
      tone: "good",
      icon: <DollarSign size={18} />,
      secondary: { label: "Unsafe prevented", value: "17" },
      trend: [11000, 11200, 11450, 11800, 12050, 12210, 12450],
    },
    {
      title: "Carbon Reduced",
      value: 392.4,
      format: "co2_kg",
      decimals: 0,
      subtitle: "estimated avoided emissions",
      footnote: "Uses grid intensity + shifted load delta.",
      delta: 0.08,
      deltaFormat: "percent",
      status: "allowed",
      tone: "good",
      icon: <Leaf size={18} />,
      trend: [310, 320, 340, 360, 375, 385, 392],
    },
    {
      title: "Safe Shift Limit",
      value: 1180,
      format: "power_kw",
      decimals: 0,
      subtitle: "topology-aware (GNN) headroom",
      footnote: "Max safe ΔP at selected bus under constraints.",
      delta: -0.03,
      deltaFormat: "percent",
      status: "mixed",
      tone: "warn",
      icon: <Zap size={18} />,
      trend: [1400, 1350, 1290, 1220, 1200, 1190, 1180],
    },
    {
      title: "Actions Blocked",
      value: 5,
      format: "number",
      decimals: 0,
      subtitle: "safety policy enforcement",
      footnote: "Blocked due to thermal/grid constraints.",
      delta: 0.0,
      deltaFormat: "number",
      status: "blocked",
      tone: "bad",
      icon: <ShieldAlert size={18} />,
      trend: [1, 2, 2, 3, 4, 4, 5],
    },
  ];

  return (
    <div className="min-h-screen bg-black p-4">
      <KpiGrid items={kpis} isLoading={isPending} />
    </div>
  );
};

export default withPageAuthRequired(DashboardPage);
>>>>>>> 25062df64ce452d2b79b32dc8441ac027740eb98
