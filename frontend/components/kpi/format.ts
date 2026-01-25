export type KpiFormat = "currency" | "number" | "percent" | "energy_kwh" | "power_kw" | "co2_kg";

export function formatKpiValue(
  value: number,
  format: KpiFormat,
  opts?: { currency?: string; maximumFractionDigits?: number }
) {
  const maxFrac = opts?.maximumFractionDigits ?? 1;

  switch (format) {
    case "currency":
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: opts?.currency ?? "USD",
        maximumFractionDigits: maxFrac,
      }).format(value);

    case "percent":
      return new Intl.NumberFormat("en-US", {
        style: "percent",
        maximumFractionDigits: maxFrac,
      }).format(value);

    case "energy_kwh":
      return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFrac }).format(value)} kWh`;

    case "power_kw":
      return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFrac }).format(value)} kW`;

    case "co2_kg":
      return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFrac }).format(value)} kg CO₂`;

    case "number":
    default:
      return new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFrac }).format(value);
  }
}

export function formatDelta(delta: number, format: "percent" | "number" = "percent") {
  const sign = delta > 0 ? "+" : "";
  if (format === "percent") {
    return `${sign}${new Intl.NumberFormat("en-US", {
      style: "percent",
      maximumFractionDigits: 1,
    }).format(delta)}`;
  }
  return `${sign}${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
  }).format(delta)}`;
}
