"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { KpiCard, KpiCardProps } from "./KpiCard";

type KpiGridProps = {
  items: KpiCardProps[];
  isLoading?: boolean;
  columns?: 2 | 3 | 4 | 6; // Control grid columns
  layout?: "row" | "grid";
};

export function KpiGrid({
  items,
  isLoading,
  columns = 4,
  layout = "grid",
}: KpiGridProps) {
  const columnClasses: Record<2 | 3 | 4 | 6, string> = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-2 lg:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
    6: "sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-6",
  };

  if (layout === "row") {
    return (
      <div
        className="flex gap-4 overflow-x-auto pb-2 pr-1 scrollbar-twin"
        role="region"
        aria-label="KPI metrics dashboard"
      >
        {items.map((kpi, idx) => (
          <div
            key={kpi.title || idx}
            className="shrink-0 w-[260px] sm:w-[280px] h-[180px]"
          >
            <KpiCard
              {...kpi}
              isLoading={isLoading || kpi.isLoading}
              className="h-full"
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 sm:gap-6",
        columnClasses[columns]
      )}
      role="region"
      aria-label="KPI metrics dashboard"
    >
      {items.map((kpi, idx) => (
        <div key={kpi.title || idx} className="min-w-0">
          <KpiCard {...kpi} isLoading={isLoading || kpi.isLoading} />
        </div>
      ))}
    </div>
  );
}
