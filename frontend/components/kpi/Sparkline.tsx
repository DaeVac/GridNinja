import React from "react";

type SparklineProps = {
  values: number[];
  width?: number;
  height?: number;
  strokeWidth?: number;
  className?: string;
};

export function Sparkline({
  values,
  width = 140,
  height = 36,
  strokeWidth = 2,
  className,
}: SparklineProps) {
  if (!values?.length) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1e-9, max - min);

  const pad = 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  const points = values
    .map((v, i) => {
      const x = pad + (i / Math.max(1, values.length - 1)) * innerW;
      const y = pad + (1 - (v - min) / range) * innerH;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} className={className} aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.9}
      />
    </svg>
  );
}
