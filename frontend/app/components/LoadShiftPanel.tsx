'use client';

import React from 'react';
import clsx from 'clsx';
import {
    Activity,
    AlertTriangle,
    CheckCircle2,
    Minus,
    Thermometer,
    TrendingDown,
    TrendingUp,
    Wind,
    Zap,
} from 'lucide-react';

import { TelemetryPoint } from '@/lib/telemetry/useTelemetryWS';

type TimeRangeKey = '15m' | '1h' | '6h';
type TrendDirection = 'up' | 'down' | 'flat';

type TrendSummary = {
    deltaKw: number;
    direction: TrendDirection;
    available: boolean;
};

const API_BASE = '/api';

const TREND_WINDOWS: Record<TimeRangeKey, number> = {
    '15m': 900,
    '1h': 3600,
    '6h': 21600,
};

const THERMAL_MAX_C = 50;
const THERMAL_BASE_C = 20;
const COOLING_MAX_KW = 2000;
const COOLING_MIN_KW = 50;
const GRID_MAX_KW = 1500;
const FREQ_MIN_HZ = 59.95;
const FREQ_BAND_HZ = 0.1;

const SAFE_SHIFT_MIN_KW = 250;
const THERMAL_MIN_MARGIN_C = 1.5;
const COOLING_MIN_HEADROOM_KW = 150;
const FREQ_MIN_MARGIN_HZ = 0.02;

const DEG = '\u00B0';

const DEFAULT_TRENDS: Record<TimeRangeKey, TrendSummary> = {
    '15m': { deltaKw: 0, direction: 'flat', available: false },
    '1h': { deltaKw: 0, direction: 'flat', available: false },
    '6h': { deltaKw: 0, direction: 'flat', available: false },
};

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}

function formatKw(value: number, digits = 0) {
    if (!Number.isFinite(value)) return 'n/a';
    return value.toFixed(digits);
}

function formatSigned(value: number, digits = 1) {
    if (!Number.isFinite(value)) return 'n/a';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(digits)}`;
}

function trendDirection(delta: number): TrendDirection {
    if (Math.abs(delta) < 1) return 'flat';
    return delta > 0 ? 'up' : 'down';
}

function trendLabel(delta: number) {
    if (Math.abs(delta) < 1) return '0 kW';
    const sign = delta > 0 ? '+' : '-';
    return `${sign}${Math.abs(delta).toFixed(0)} kW`;
}

function toneForUtilization(utilization: number) {
    if (utilization >= 0.85) return 'critical';
    if (utilization >= 0.65) return 'warning';
    return 'normal';
}

function toneClasses(tone: 'critical' | 'warning' | 'normal') {
    if (tone === 'critical') return { bar: 'bg-[#E10600]', text: 'text-[#E10600]' };
    if (tone === 'warning') return { bar: 'bg-[#FF5A00]', text: 'text-[#FFB800]' };
    return { bar: 'bg-[#FFD400]', text: 'text-[#FFE65C]' };
}

function TrendPill({ label, summary }: { label: string; summary: TrendSummary }) {
    const Icon =
        summary.direction === 'up' ? TrendingUp :
            summary.direction === 'down' ? TrendingDown :
                Minus;
    const tone = summary.direction === 'up' ? 'text-[#FFE65C]' : summary.direction === 'down' ? 'text-[#FF5A00]' : 'text-[#7A3A1A]';

    return (
        <div className="flex items-center gap-2 rounded-lg border border-[#3A1A0A] bg-[#120805]/70 px-2.5 py-1.5">
            <span className="text-[10px] uppercase tracking-[0.2em] text-[#7A3A1A]">{label}</span>
            <Icon className={clsx('w-3 h-3', tone)} />
            <span className="text-[11px] font-mono text-[#FFE65C]">
                {summary.available ? trendLabel(summary.deltaKw) : 'n/a'}
            </span>
        </div>
    );
}

function ConstraintRow({
    label,
    value,
    unit,
    utilization,
    helper,
    icon: Icon,
}: {
    label: string;
    value: string;
    unit: string;
    utilization: number;
    helper: string;
    icon: React.ComponentType<{ className?: string }>;
}) {
    const tone = toneForUtilization(utilization);
    const colors = toneClasses(tone);
    const pct = clamp(utilization * 100, 0, 100);

    return (
        <div className="rounded-lg border border-[#3A1A0A] bg-[#120805]/80 p-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs text-[#7A3A1A] uppercase tracking-[0.2em]">
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                </div>
                <div className="text-xs text-[#5A2A14]">{helper}</div>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
                <span className={clsx('text-lg font-semibold', colors.text)}>{value}</span>
                <span className="text-xs text-[#5A2A14]">{unit}</span>
            </div>
            <div className="mt-2 h-1.5 w-full rounded-full bg-[#1A0B06]">
                <div
                    className={clsx('h-1.5 rounded-full transition-all duration-700', colors.bar)}
                    style={{ width: `${pct}%` }}
                />
            </div>
        </div>
    );
}

export default function LoadShiftPanel({ telemetry }: { telemetry: TelemetryPoint | null }) {
    const [trends, setTrends] = React.useState<Record<TimeRangeKey, TrendSummary>>(DEFAULT_TRENDS);

    React.useEffect(() => {
        let alive = true;

        const fetchTrends = async () => {
            try {
                const results = await Promise.all(
                    (Object.keys(TREND_WINDOWS) as TimeRangeKey[]).map(async (key) => {
                        const windowS = TREND_WINDOWS[key];
                        const res = await fetch(`${API_BASE}/telemetry/timeseries?window_s=${windowS}&mode=live`, {
                            cache: 'no-store',
                        });
                        if (!res.ok) return { key, data: null };
                        const data = await res.json();
                        return { key, data };
                    })
                );

                if (!alive) return;

                const nextTrends: Record<TimeRangeKey, TrendSummary> = { ...DEFAULT_TRENDS };
                results.forEach(({ key, data }) => {
                    if (!Array.isArray(data) || data.length < 2) return;
                    const first = Number(data[0]?.safe_shift_kw);
                    const last = Number(data[data.length - 1]?.safe_shift_kw);
                    if (!Number.isFinite(first) || !Number.isFinite(last)) return;
                    const delta = last - first;
                    nextTrends[key] = {
                        deltaKw: delta,
                        direction: trendDirection(delta),
                        available: true,
                    };
                });

                setTrends(nextTrends);
            } catch {
                if (!alive) return;
                setTrends(DEFAULT_TRENDS);
            }
        };

        fetchTrends();
        const interval = window.setInterval(fetchTrends, 30000);
        return () => {
            alive = false;
            window.clearInterval(interval);
        };
    }, []);

    const metrics = React.useMemo(() => {
        const hasTelemetry = Boolean(telemetry);
        if (!hasTelemetry) {
            return {
                hasTelemetry,
                safeShiftKw: 0,
                thermalMarginC: 0,
                coolingHeadroomKw: 0,
                frequencyMarginHz: 0,
                gridHeadroomKw: 0,
                thermalUtil: 0,
                coolingUtil: 0,
                frequencyUtil: 0,
                gridUtil: 0,
                primary: 'n/a',
                confidence: 0,
                canShift: false,
                statusLine: 'Awaiting telemetry lock.',
                recommendedAction: 'Hold. Waiting for telemetry.',
            };
        }

        const tempC = telemetry?.rack_temp_c ?? 0;
        const coolingKw = telemetry?.cooling_kw ?? 0;
        const freqHz = telemetry?.frequency_hz ?? 60;
        const safeShiftKw = telemetry?.safe_shift_kw ?? 0;

        const thermalMarginC = THERMAL_MAX_C - tempC;
        const coolingHeadroomKw = COOLING_MAX_KW - coolingKw;
        const frequencyMarginHz = freqHz - FREQ_MIN_HZ;
        const gridHeadroomKw = safeShiftKw;

        const thermalUtil = clamp((tempC - THERMAL_BASE_C) / (THERMAL_MAX_C - THERMAL_BASE_C), 0, 1);
        const coolingUtil = clamp((coolingKw - COOLING_MIN_KW) / (COOLING_MAX_KW - COOLING_MIN_KW), 0, 1);
        const frequencyUtil = clamp(1 - (freqHz - FREQ_MIN_HZ) / FREQ_BAND_HZ, 0, 1);
        const gridUtil = clamp(1 - safeShiftKw / GRID_MAX_KW, 0, 1);

        const clampCandidates = [
            { reason: 'THERMAL', value: thermalUtil },
            { reason: 'GRID', value: Math.max(gridUtil, frequencyUtil) },
            { reason: 'POLICY', value: coolingUtil },
        ];
        const sorted = [...clampCandidates].sort((a, b) => b.value - a.value);
        const primary = sorted[0]?.reason ?? 'THERMAL';
        const gap = sorted.length > 1 ? sorted[0].value - sorted[1].value : 0;
        const confidence = clamp(0.55 + gap * 0.9, 0.4, 0.95);

        const canShift =
            hasTelemetry &&
            safeShiftKw > SAFE_SHIFT_MIN_KW &&
            thermalMarginC > THERMAL_MIN_MARGIN_C &&
            coolingHeadroomKw > COOLING_MIN_HEADROOM_KW &&
            frequencyMarginHz > FREQ_MIN_MARGIN_HZ;

        const statusLine = canShift
            ? `Yes. ${formatKw(safeShiftKw)} kW headroom with ${formatKw(thermalMarginC, 1)}${DEG}C thermal margin. Limiting constraint: ${primary}.`
            : `No. ${primary} constraint is limiting right now.`;

        let recommendedAction = 'Hold. Waiting for telemetry.';
        if (canShift) {
            const recommendedKw = Math.max(50, Math.min(safeShiftKw, Math.round(safeShiftKw * 0.6 / 10) * 10));
            recommendedAction = `Shift up to ${formatKw(recommendedKw)} kW now and re-check in 5 minutes.`;
        } else if (primary === 'THERMAL') {
            recommendedAction = `Hold shifts until thermal margin exceeds ${THERMAL_MIN_MARGIN_C.toFixed(1)}${DEG}C.`;
        } else if (primary === 'GRID') {
            recommendedAction = `Hold shifts until frequency margin exceeds ${FREQ_MIN_MARGIN_HZ.toFixed(2)} Hz.`;
        } else {
            recommendedAction = `Hold shifts until cooling headroom exceeds ${formatKw(COOLING_MIN_HEADROOM_KW)} kW.`;
        }

        return {
            hasTelemetry,
            safeShiftKw,
            thermalMarginC,
            coolingHeadroomKw,
            frequencyMarginHz,
            gridHeadroomKw,
            thermalUtil,
            coolingUtil,
            frequencyUtil,
            gridUtil,
            primary,
            confidence,
            canShift,
            statusLine,
            recommendedAction,
        };
    }, [telemetry]);

    const StatusIcon = metrics.hasTelemetry
        ? (metrics.canShift ? CheckCircle2 : AlertTriangle)
        : Activity;
    const statusTone = metrics.hasTelemetry
        ? (metrics.canShift ? 'text-[#FFE65C]' : 'text-[#E10600]')
        : 'text-[#7A3A1A]';
    const statusBadge = metrics.hasTelemetry
        ? (metrics.canShift ? 'SHIFT OK' : 'SHIFT HOLD')
        : 'NO DATA';

    return (
        <div className="relative isolate w-full rounded-xl border border-[#3A1A0A] bg-[#0B0705] shadow-xl">
            <div className="absolute inset-0 opacity-20 pointer-events-none bg-[radial-gradient(circle_at_top,_rgba(255,90,0,0.35),_transparent_55%)]" />
            <div className="relative flex flex-col gap-4 p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <div className="text-[11px] uppercase tracking-[0.3em] text-[#7A3A1A]">Safe Shift Headroom</div>
                        <div className="mt-2 text-3xl sm:text-4xl font-bold text-[#FFE65C]">
                            {metrics.hasTelemetry ? formatKw(metrics.safeShiftKw) : 'n/a'}
                            <span className="ml-2 text-sm font-medium text-[#7A3A1A]">kW</span>
                        </div>
                        <div className="mt-1 text-xs text-[#5A2A14]">Live headroom to shift load safely.</div>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                        <TrendPill label="15M" summary={trends['15m']} />
                        <TrendPill label="1H" summary={trends['1h']} />
                        <TrendPill label="6H" summary={trends['6h']} />
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="rounded-lg border border-[#3A1A0A] bg-[#120805]/80 p-3">
                        <div className="flex items-center justify-between">
                            <div className="text-[11px] uppercase tracking-[0.25em] text-[#7A3A1A]">
                                Can I shift load now
                            </div>
                            <div className={clsx('flex items-center gap-2 text-xs font-semibold', statusTone)}>
                                <StatusIcon className="w-4 h-4" />
                                {statusBadge}
                            </div>
                        </div>
                        <div className="mt-2 text-sm text-[#FFE65C]">{metrics.statusLine}</div>
                    </div>

                    <div className="rounded-lg border border-[#3A1A0A] bg-[#120805]/80 p-3">
                        <div className="text-[11px] uppercase tracking-[0.25em] text-[#7A3A1A]">Primary clamp reason</div>
                        <div className="mt-2 flex items-center justify-between">
                            <span className="text-lg font-semibold text-[#FFB800]">{metrics.primary}</span>
                            <span className="text-xs text-[#7A3A1A]">
                                Confidence {metrics.hasTelemetry ? `${Math.round(metrics.confidence * 100)}%` : 'n/a'}
                            </span>
                        </div>
                        <div className="mt-1 text-xs text-[#5A2A14]">Limiting constraint across thermal, grid, or policy.</div>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <ConstraintRow
                        label="Thermal margin"
                        value={metrics.hasTelemetry ? formatKw(metrics.thermalMarginC, 1) : 'n/a'}
                        unit={`${DEG}C`}
                        utilization={metrics.thermalUtil}
                        helper="to max"
                        icon={Thermometer}
                    />
                    <ConstraintRow
                        label="Cooling headroom"
                        value={metrics.hasTelemetry ? formatKw(metrics.coolingHeadroomKw, 0) : 'n/a'}
                        unit="kW"
                        utilization={metrics.coolingUtil}
                        helper="available"
                        icon={Wind}
                    />
                    <ConstraintRow
                        label="Frequency margin"
                        value={metrics.hasTelemetry ? formatSigned(metrics.frequencyMarginHz, 3) : 'n/a'}
                        unit="Hz"
                        utilization={metrics.frequencyUtil}
                        helper="to min"
                        icon={Activity}
                    />
                    <ConstraintRow
                        label="Grid headroom"
                        value={metrics.hasTelemetry ? formatKw(metrics.gridHeadroomKw, 0) : 'n/a'}
                        unit="kW"
                        utilization={metrics.gridUtil}
                        helper="available"
                        icon={Zap}
                    />
                </div>

                <div className="rounded-lg border border-[#3A1A0A] bg-[#120805]/90 p-3">
                    <div className="text-[11px] uppercase tracking-[0.25em] text-[#7A3A1A]">Recommended action</div>
                    <div className="mt-2 text-sm text-[#FFE65C]">{metrics.recommendedAction}</div>
                </div>
            </div>
        </div>
    );
}
