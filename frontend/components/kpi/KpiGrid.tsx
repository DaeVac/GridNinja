"use client";

import React from "react";
import { KpiCard, KpiCardProps } from "./KpiCard";

type KpiGridProps = {
  items: KpiCardProps[];
  isLoading?: boolean;
  columns?: 2 | 3 | 4; // Control grid columns
};

export function KpiGrid({ items, isLoading, columns = 3 }: KpiGridProps) {
  return (
    <div
      className="flex flex-wrap gap-8 p-4 sm:p-6"
      role="region"
      aria-label="KPI metrics dashboard"
    >
      {items.map((kpi, idx) => (
        <div
          key={kpi.title || idx}
          className="flex-1 min-w-[280px] max-w-[340px]"
        >
          <KpiCard {...kpi} isLoading={isLoading || kpi.isLoading} />
        </div>
      ))}
    </div>
  );
}
