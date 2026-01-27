"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Sparkline } from "./Sparkline";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { formatDelta, formatKpiValue, KpiFormat } from "./format";

// Design tokens for consistency
const COLORS = {
  card: {
    background: "#2d313c",
    border: "rgba(255, 255, 255, 0.1)",
  },
  status: {
    allowed: {
      bg: "bg-emerald-500/15",
      text: "text-emerald-300",
      border: "border-emerald-500/30",
    },
    blocked: {
      bg: "bg-rose-500/15",
      text: "text-rose-300",
      border: "border-rose-500/30",
    },
    mixed: {
      bg: "bg-amber-500/15",
      text: "text-amber-300",
      border: "border-amber-500/30",
    },
  },
} as const;

const SIZES = {
  icon: { width: 48, height: 48 },
  card: { minWidth: 280, maxWidth: 340 },
  gap: 24,
} as const;

export type KpiStatus = "allowed" | "blocked" | "mixed" | "neutral";
export type KpiTone = "good" | "warn" | "bad" | "neutral";

export type KpiSecondaryMetric = {
  label: string;
  value: string;
};

export type KpiCardProps = {
  title: string;
  value?: number;
  format?: KpiFormat;
  currency?: string;
  decimals?: number;
  subtitle?: string;
  footnote?: string;
  delta?: number;
  deltaFormat?: "percent" | "number";
  status?: KpiStatus;
  tone?: KpiTone;
  icon?: React.ReactNode;
  trend?: number[];
  isLoading?: boolean;
  secondary?: KpiSecondaryMetric;
  className?: string;
};

function statusBadge(status: KpiStatus | undefined) {
  if (!status || status === "neutral") return null;

  const config = {
    allowed: { label: "Allowed", ...COLORS.status.allowed },
    blocked: { label: "Blocked", ...COLORS.status.blocked },
    mixed: { label: "Mixed", ...COLORS.status.mixed },
    neutral: { label: "Neutral", bg: "bg-slate-500/15", text: "text-slate-300", border: "border-slate-500/30" },
  }[status];

  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px]",
        config.bg,
        config.text,
        config.border
      )}
    >
      {config.label}
    </Badge>
  );
}

function deltaChip(
  delta: number | undefined,
  deltaFormat: "percent" | "number"
) {
  if (delta === undefined || Number.isNaN(delta)) return null;

  const isUp = delta > 0;
  const isDown = delta < 0;
  const Icon = isUp ? ArrowUpRight : isDown ? ArrowDownRight : Minus;
  const cls = isUp
    ? "text-emerald-300"
    : isDown
    ? "text-rose-300"
    : "text-slate-300";

  return (
    <div className={cn("flex items-center gap-1 text-xs font-medium", cls)}>
      <Icon size={14} />
      <span>{formatDelta(delta, deltaFormat)}</span>
    </div>
  );
}

export function KpiCard({
  title,
  value,
  format = "number",
  currency = "USD",
  decimals = 1,
  subtitle,
  footnote,
  delta,
  deltaFormat = "percent",
  status = "neutral",
  tone = "neutral",
  icon,
  trend,
  isLoading,
  secondary,
  className,
}: KpiCardProps) {
  if (isLoading) {
    return (
      <article
        className={cn("rounded-2xl p-6", className)}
        style={{
          backgroundColor: COLORS.card.background,
          boxShadow:
            "inset 0 2px 5px rgba(0, 0, 0, 0.3), 0 5px 15px rgba(0, 0, 0, 0.3)",
        }}
        aria-busy="true"
        aria-label="Loading KPI card"
      >
        <div className="flex flex-col gap-4">
          <div className="h-5 w-36 bg-slate-700/50 rounded-md" />
          <div className="h-10 w-48 bg-slate-700/50 rounded-md" />
          <div className="h-4 w-28 bg-slate-700/50 rounded-md" />
        </div>
      </article>
    );
  }

  const valueStr =
    value === undefined
      ? "—"
      : formatKpiValue(value, format, {
          currency,
          maximumFractionDigits: decimals,
        });

  const toneRing =
    tone === "good"
      ? "ring-2 ring-emerald-500/30"
      : tone === "warn"
      ? "ring-2 ring-amber-500/30"
      : tone === "bad"
      ? "ring-2 ring-rose-500/30"
      : "";

  return (
    <article
      className={cn(
        "rounded-2xl p-6 transition-transform duration-200 hover:scale-[1.02]",
        className,
        toneRing
      )}
      style={{
        backgroundColor: COLORS.card.background,
        boxShadow:
          "inset 0 2px 5px rgba(0, 0, 0, 0.3), 0 5px 15px rgba(0, 0, 0, 0.3)",
      }}
      aria-label={`${title} KPI card`}
    >
      {/* Header Section */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold text-slate-100 truncate">
              {title}
            </h3>
            {statusBadge(status)}
          </div>
          {subtitle && (
            <p className="text-xs text-slate-400 truncate">{subtitle}</p>
          )}
        </div>
        {icon && (
          <div
            className="shrink-0 flex items-center justify-center rounded-xl bg-slate-800/60 text-slate-200 shadow-md"
            style={{
              width: SIZES.icon.width,
              height: SIZES.icon.height,
            }}
            aria-hidden="true"
          >
            {icon}
          </div>
        )}
      </div>

      {/* Value Section */}
      <div className="flex items-baseline gap-3 mb-4">
        <p className="text-4xl font-bold text-white tracking-tight">
          {valueStr}
        </p>
        {deltaChip(delta, deltaFormat)}
      </div>

      {/* Secondary Metric */}
      {secondary && (
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-slate-700/50 bg-slate-900/40 px-3 py-1.5 text-xs">
          <span className="text-slate-400">{secondary.label}</span>
          <span className="font-semibold text-slate-200">{secondary.value}</span>
        </div>
      )}

      {/* Footer Section */}
      <div className="flex items-end justify-between gap-4 mt-4 pt-4 border-t border-slate-700/30">
        <div className="min-w-0 flex-1">
          {footnote && (
            <p className="text-xs text-slate-400 line-clamp-2">{footnote}</p>
          )}
        </div>
        {trend?.length ? (
          <div className="text-slate-300 shrink-0">
            <Sparkline values={trend} />
          </div>
        ) : null}
      </div>
    </article>
  );
}
