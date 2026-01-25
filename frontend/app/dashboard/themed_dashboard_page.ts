"use client";
import React from "react";
import { withPageAuthRequired } from "@auth0/nextjs-auth0";
import { KpiGrid } from "@/components/kpi/KpiGrid";
import { KpiCardProps } from "@/components/kpi/KpiCard";
import { DollarSign, ShieldAlert, Leaf, Zap, Flame, Activity } from "lucide-react";

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
    <div className="min-h-screen bg-black p-6">
      {/* Ambient glow effects - matching digital twin theme */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 right-1/4 w-96 h-96 bg-[#E10600] opacity-10 blur-3xl rounded-full animate-pulse"></div>
        <div className="absolute bottom-1/4 left-1/4 w-96 h-96 bg-[#FFD400] opacity-5 blur-3xl rounded-full"></div>
        <div className="absolute top-1/2 left-1/2 w-64 h-64 bg-[#FF5A00] opacity-8 blur-2xl rounded-full"></div>
      </div>

      <div className="relative z-10">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <Flame 
                className="w-8 h-8 text-[#E10600]" 
                style={{ filter: 'drop-shadow(0 0 8px rgba(225, 6, 0, 0.6))' }} 
              />
              <h1 className="text-3xl font-bold bg-gradient-to-r from-[#FFD400] via-[#FF5A00] to-[#E10600] bg-clip-text text-transparent">
                GridNinja Control Plane
              </h1>
            </div>
            <div className="flex items-center gap-2 bg-[#120805] border border-[#E10600]/30 rounded-full px-4 py-2">
              <div 
                className="w-2 h-2 rounded-full bg-[#E10600]"
                style={{ 
                  boxShadow: '0 0 8px rgba(225, 6, 0, 0.8)',
                  animation: 'pulse 1.5s ease-in-out infinite'
                }}
              ></div>
              <span className="text-sm text-[#FFE65C]">Live Monitoring</span>
            </div>
          </div>
          <p className="text-[#7A3A1A]">Physics-informed control for Smart Grid + Data Center operations</p>
        </div>

        {/* KPI Grid with themed wrapper */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-[#FFB800] mb-4 flex items-center gap-2">
            <Activity className="w-5 h-5" />
            Key Performance Indicators
          </h2>
          <KpiGrid items={kpis} isLoading={isPending} />
        </div>

        {/* System Status Banner */}
        <div className="mt-6 bg-gradient-to-r from-[#FFD400]/10 to-[#FFB800]/10 border border-[#FFD400]/40 rounded-lg p-4 flex items-start gap-3 shadow-lg">
          <Activity 
            className="w-5 h-5 text-[#FFD400] flex-shrink-0 mt-0.5" 
            style={{ filter: 'drop-shadow(0 0 6px rgba(255, 212, 0, 0.6))' }} 
          />
          <div>
            <h3 className="font-semibold text-[#FFB800] mb-1">System Status: Optimal</h3>
            <p className="text-sm text-[#FFE65C]">
              All safety constraints satisfied. Carbon-aware load shifting active. Grid topology stable.
            </p>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes pulse {
          0%, 100% {
            opacity: 1;
            transform: scale(1);
          }
          50% {
            opacity: 0.8;
            transform: scale(1.2);
          }
        }
      `}</style>
    </div>
  );
};

export default withPageAuthRequired(DashboardPage);
