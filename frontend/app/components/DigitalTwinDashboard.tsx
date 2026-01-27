'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
    LineChart, Line,
    AreaChart, Area,
    XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
    RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
} from 'recharts';
import {
    Activity, Zap, AlertTriangle, TrendingUp, Flame, Battery, Gauge, CloudRain
} from 'lucide-react';
import { useTelemetryWS } from '@/lib/telemetry/useTelemetryWS';
import DemoModeButton from './DemoModeButton';

type TimeRangeKey = '15m' | '1h' | '6h';

const API_BASE = "/api";
const WS_BASE =
    (process.env.NEXT_PUBLIC_WS_BASE_URL ?? 'ws://localhost:8000').replace(/\/+$/, '');

const rangeToWindowS: Record<TimeRangeKey, number> = {
    '15m': 900,
    '1h': 3600,
    '6h': 21600,
};

const COOLING_COP = 4.0;

type KpiSummary = {
    money_saved_usd: number;
    co2_avoided_kg: number;
    unsafe_actions_prevented_total: number;
    blocked_rate_pct: number;
    jobs_completed_on_time_pct: number;
    sla_penalty_usd: number;
};

function clamp(n: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, n));
}

function getStatusColor(status: 'critical' | 'warning' | 'normal') {
    switch (status) {
        case 'critical': return '#E10600';
        case 'warning': return '#FF5A00';
        default: return '#FFD400';
    }
}

function formatDebug(value?: number, digits = 1) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value.toFixed(digits)
        : 'n/a';
}

export default function DigitalTwinDashboard() {
    const [timeRange, setTimeRange] = useState<TimeRangeKey>('1h');
    const [pulseIntensity, setPulseIntensity] = useState(1);

    // Real-time telemetry over WS
    const { status: wsStatus, transport, latest, buffer } = useTelemetryWS(180);

    // KPI rollups
    const [kpi, setKpi] = useState<KpiSummary | null>(null);

    // Backfilled chart series when time range changes
    const [series, setSeries] = useState<typeof buffer>([]);

    // Pulse animation
    useEffect(() => {
        const interval = setInterval(() => {
            setPulseIntensity(prev => (prev === 1 ? 1.2 : 1));
        }, 1500);
        return () => clearInterval(interval);
    }, []);

    // Poll KPI every 5s
    useEffect(() => {
        let alive = true;

        const fetchKPI = async () => {
            try {
                const res = await fetch(`${API_BASE}/kpi/summary?window_s=3600`, { cache: 'no-store' });
                if (!res.ok) return;
                const data = (await res.json()) as KpiSummary;
                if (alive) setKpi(data);
            } catch {
                // swallow
            }
        };

        fetchKPI();
        const interval = setInterval(fetchKPI, 5000);
        return () => {
            alive = false;
            clearInterval(interval);
        };
    }, []);

    // Backfill timeseries on timeRange change
    useEffect(() => {
        let alive = true;
        const windowS = rangeToWindowS[timeRange];

        const fetchSeries = async () => {
            try {
                const res = await fetch(`${API_BASE}/telemetry/timeseries?window_s=${windowS}&mode=live`, {
                    cache: 'no-store',
                });
                if (!res.ok) return;

                const data = await res.json();
                if (!alive) return;

                const trimmed = Array.isArray(data) ? data.slice(-240) : [];
                setSeries(trimmed);
            } catch {
                // ignore
            }
        };

        fetchSeries();
        const interval = setInterval(fetchSeries, 10000);
        return () => {
            alive = false;
            clearInterval(interval);
        };
    }, [timeRange]);

    // Choose chart source
    const chartData = series.length > 0 ? series : buffer;

    // Physical state cards
    const physicalState = useMemo(() => {
        const freq = latest?.frequency_hz ?? 60.0;
        const loadKw = latest?.total_load_kw ?? 1000.0;
        const tempC = latest?.rack_temp_c ?? 42.0;
        const coolingKw = latest?.cooling_kw ?? 800.0;

        return [
            {
                metric: 'Frequency',
                value: Number(freq.toFixed(3)),
                unit: 'Hz',
                status: freq < 59.95 ? 'critical' : freq < 59.98 ? 'warning' : 'normal',
                icon: Activity,
            },
            {
                metric: 'Power',
                value: Number((loadKw / 1000).toFixed(2)),
                unit: 'MW',
                status: loadKw > 1100 ? 'warning' : 'normal',
                icon: Zap,
            },
            {
                metric: 'Rack Temp',
                value: Number(tempC.toFixed(1)),
                unit: '°C',
                status: tempC > 48 ? 'critical' : tempC > 45 ? 'warning' : 'normal',
                icon: Flame,
            },
            {
                metric: 'Cooling',
                value: Number(coolingKw.toFixed(0)),
                unit: 'kW',
                status: coolingKw > 950 ? 'warning' : 'normal',
                icon: Battery,
            },
        ] as const;
    }, [latest]);

    // Derived efficiency metrics
    const efficiencyMetrics = useMemo(() => {
        const totalLoadKw = latest?.total_load_kw ?? 1000;
        const coolingKw = latest?.cooling_kw ?? 800;
        const itLoadKw = latest?.it_load_kw ?? totalLoadKw;
        const otherKw = 0;
        const facilityKw = itLoadKw + coolingKw + otherKw;
        const pue = facilityKw / Math.max(itLoadKw, 1e-6);
        const coolingTargetKw = itLoadKw / Math.max(COOLING_COP, 1e-6);
        const coolingStatus =
            coolingKw > coolingTargetKw * 1.15 ? 'critical' :
                coolingKw > coolingTargetKw * 1.05 ? 'warning' :
                    'normal';
        const losses = (latest?.stress_score ?? 0.1) * 100;

        return [
            { metric: 'PUE', value: Number(pue.toFixed(2)), target: 1.35, status: pue > 1.6 ? 'warning' : 'normal' },
            { metric: 'Cooling kW', value: Number(coolingKw.toFixed(0)), target: Number(coolingTargetKw.toFixed(0)), status: coolingStatus },
            { metric: 'Safe Shift', value: Number((latest?.safe_shift_kw ?? 0).toFixed(0)), target: 1200, status: (latest?.safe_shift_kw ?? 0) < 900 ? 'warning' : 'normal' },
            { metric: 'Stress', value: Number(losses.toFixed(1)), target: 5.0, status: losses > 30 ? 'critical' : losses > 10 ? 'warning' : 'normal' },
        ] as const;
    }, [latest]);

    // Carbon chart data
    const carbonData = useMemo(() => {
        return chartData.map((p: any, idx: number) => ({
            time: (p.ts ?? '').slice(11, 19) || `${idx}`,
            intensity: p.carbon_g_per_kwh ?? 450,
            workload: ((p.it_load_kw ?? p.total_load_kw ?? 1000) / 1000),
        }));
    }, [chartData]);

    // Risk metrics
    const riskMetrics = useMemo(() => {
        const temp = latest?.rack_temp_c ?? 42;
        const stress = latest?.stress_score ?? 0.1;
        const pumpRisk = clamp(Math.round((temp - 40) * 5 + stress * 100), 0, 99);

        return [
            { component: 'HVAC-1', ttf: 720, exceedance: Math.round(stress * 10), forecast: 'stable' },
            { component: 'Transformer-A', ttf: 2160, exceedance: Math.round(stress * 6), forecast: 'declining' },
            { component: 'Battery Bank', ttf: 4320, exceedance: Math.round(stress * 3), forecast: 'stable' },
            { component: 'Cooling Pump', ttf: 168, exceedance: pumpRisk, forecast: pumpRisk > 35 ? 'critical' : 'watch' },
        ];
    }, [latest]);

    // Radar chart data
    const predictionRadar = useMemo(() => {
        const temp = clamp(latest?.rack_temp_c ?? 42, 0, 100);
        const load = clamp(((latest?.it_load_kw ?? latest?.total_load_kw ?? 1000) / 15), 0, 100);
        const eff = clamp(100 - ((latest?.cooling_kw ?? 800) / 12), 0, 100);
        const rel = clamp(100 - (latest?.stress_score ?? 0.1) * 100, 0, 100);
        const carb = clamp(((latest?.carbon_g_per_kwh ?? 450) / 7), 0, 100);

        return [
            { metric: 'Thermal', current: 100 - temp, forecast: 100 - clamp(temp + 5, 0, 100), max: 100 },
            { metric: 'Load', current: load, forecast: clamp(load + 10, 0, 100), max: 100 },
            { metric: 'Efficiency', current: eff, forecast: clamp(eff - 7, 0, 100), max: 100 },
            { metric: 'Reliability', current: rel, forecast: clamp(rel - 4, 0, 100), max: 100 },
            { metric: 'Carbon', current: 100 - carb, forecast: 100 - clamp(carb + 3, 0, 100), max: 100 },
        ];
    }, [latest]);

    // Flow rates chart
    const flowRates = useMemo(() => {
        return chartData.slice(-60).map((p: any, idx: number) => ({
            time: (p.ts ?? '').slice(11, 19) || `${idx}`,
            cooling: p.cooling_kw ?? 800,
            process: p.it_load_kw ?? p.total_load_kw ?? 1000,
            return: p.safe_shift_kw ?? 1200,
        }));
    }, [chartData]);

    const liveLabel =
        wsStatus === 'open' ? 'Live Sync Active' :
            wsStatus === 'connecting' ? 'Connecting...' :
                wsStatus === 'closed' ? 'Offline' : 'WS Error';
    const transportLabel = (transport ?? 'ws').toUpperCase();
    const lastTelemetryTs = latest?.ts ?? 'n/a';
    const qPassiveKw = latest?.q_passive_kw;
    const qActiveKw = latest?.q_active_kw;
    const coolingTargetKw = latest?.cooling_target_kw;
    const coolingCop = latest?.cooling_cop;

    return (
        <div className="flex flex-col h-screen w-full bg-black text-slate-100 font-sans overflow-hidden">
            {/* Header */}
            <header className="bg-[#120805] border-b border-[#3A1A0A] px-4 py-4 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between sticky top-0 z-30 shadow-lg">
                <div className="flex flex-wrap items-center gap-4">
                    <Flame className="w-8 h-8 text-[#E10600]" style={{ filter: 'drop-shadow(0 0 8px rgba(225, 6, 0, 0.6))' }} />
                    <div className="hidden sm:block h-6 w-px bg-[#3A1A0A]" />
                    <h1 className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-[#FFD400] via-[#FF5A00] to-[#E10600] bg-clip-text text-transparent">
                        Digital Twin Monitor
                    </h1>
                    <div className="hidden sm:block h-6 w-px bg-[#3A1A0A]" />
                    <a
                        href="/dashboard"
                        className="inline-flex items-center gap-2 rounded-full border border-[#E10600]/30 bg-[#120805] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#FFE65C] transition hover:border-[#E10600]/60 hover:text-white"
                    >
                        {"<-"} Mission Control
                    </a>
                </div>

                <div className="flex flex-wrap items-center gap-4">
                    {/* Time range selector */}
                    <div className="flex items-center gap-2 bg-[#120805] border border-[#E10600]/30 rounded-full px-2 py-1">
                        {(['15m', '1h', '6h'] as TimeRangeKey[]).map(r => (
                            <button
                                key={r}
                                onClick={() => setTimeRange(r)}
                                className={`px-3 py-1 text-xs rounded-full transition ${timeRange === r ? 'bg-[#E10600]/30 text-[#FFE65C]' : 'text-[#7A3A1A] hover:text-[#FFE65C]'
                                    }`}
                            >
                                {r.toUpperCase()}
                            </button>
                        ))}
                    </div>

                    {/* Live sync pill */}
                    <div className="flex items-center gap-2 bg-[#120805] border border-[#E10600]/30 rounded-full px-4 py-2">
                        <div
                            className="w-2 h-2 rounded-full bg-[#E10600] transition-all duration-300"
                            style={{
                                transform: `scale(${pulseIntensity})`,
                                boxShadow: `0 0 ${8 * pulseIntensity}px rgba(225, 6, 0, 0.8)`,
                                opacity: wsStatus === 'open' ? 1 : 0.5,
                            }}
                        />
                        <span className="text-sm text-[#FFE65C]">{liveLabel}</span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-[#120805] border border-[#3A1A0A] text-[#FFE65C]">
                            {transportLabel}
                        </span>
                    </div>
                    <DemoModeButton />
                </div>
            </header>

            {/* Main Content */}
            <main className="flex-1 min-h-0 p-4 sm:p-6 relative overflow-y-auto scrollbar-twin">
                {/* Ambient glow effects */}
                <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
                    <div className="absolute top-0 right-1/4 w-96 h-96 bg-[#E10600] opacity-10 blur-3xl rounded-full animate-pulse"></div>
                    <div className="absolute bottom-1/4 left-1/4 w-96 h-96 bg-[#FFD400] opacity-5 blur-3xl rounded-full"></div>
                    <div className="absolute top-1/2 left-1/2 w-64 h-64 bg-[#FF5A00] opacity-8 blur-2xl rounded-full"></div>
                </div>

                <div className="relative z-10 max-w-7xl mx-auto space-y-6">
                    {/* Debug Banner */}
                    <div className="bg-[#120805]/80 border border-[#3A1A0A] rounded-lg px-4 py-2 text-[10px] font-mono text-[#FFE65C] flex flex-wrap gap-3 shadow-sm">
                        <span className="text-[#7A3A1A] uppercase tracking-[0.2em] font-semibold">Debug</span>
                        <span>API: {API_BASE}</span>
                        <span>WS: {WS_BASE}</span>
                        <span>Last TS: {lastTelemetryTs}</span>
                        <span>q_passive: {formatDebug(qPassiveKw)} kW</span>
                        <span>q_active: {formatDebug(qActiveKw)} kW</span>
                        <span>cooling_target: {formatDebug(coolingTargetKw)} kW</span>
                        <span>COP: {formatDebug(coolingCop, 2)}</span>
                    </div>

                    {/* A. PHYSICAL STATE */}
                    <div>
                        <h2 className="text-lg font-semibold text-[#E10600] mb-4 flex items-center gap-2">
                            <Gauge className="w-5 h-5" />
                            Physical State (Real-time)
                        </h2>

                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                            {physicalState.map((stat, idx) => {
                                const Icon = stat.icon;
                                const col = getStatusColor(stat.status);
                                return (
                                    <div
                                        key={idx}
                                        className="bg-gradient-to-br from-[#120805] to-[#1A0B06] border rounded-lg p-4 transition-all shadow-lg"
                                        style={{
                                            borderColor: `${col}40`,
                                            boxShadow: `0 0 20px ${col}20`,
                                        }}
                                    >
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-[#7A3A1A] text-sm font-medium">{stat.metric}</span>
                                            <Icon
                                                className="w-4 h-4"
                                                style={{ color: col, filter: `drop-shadow(0 0 4px ${col})` }}
                                            />
                                        </div>

                                        <div className="flex items-baseline gap-1">
                                            <span
                                                className="text-2xl font-bold"
                                                style={{ color: col, textShadow: `0 0 10px ${col}60` }}
                                            >
                                                {stat.value}
                                            </span>
                                            <span className="text-sm text-[#5A2A14]">{stat.unit}</span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Flow Rates Chart */}
                    <div className="bg-gradient-to-br from-[#120805] to-[#1A0B06] border border-[#3A1A0A] rounded-lg p-6 shadow-xl">
                        <h3 className="text-lg font-semibold text-[#FFE65C] mb-4">
                            Cooling vs Load vs Safe Shift
                        </h3>
                        <ResponsiveContainer width="100%" height={240}>
                            <LineChart data={flowRates}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#3A1A0A" />
                                <XAxis dataKey="time" stroke="#7A3A1A" style={{ fontSize: 12 }} />
                                <YAxis stroke="#7A3A1A" style={{ fontSize: 12 }} />
                                <Tooltip
                                    contentStyle={{ backgroundColor: '#120805', border: '1px solid #5A2A14', borderRadius: 8 }}
                                    labelStyle={{ color: '#FFE65C' }}
                                />
                                <Legend wrapperStyle={{ fontSize: 12 }} />
                                <Line type="monotone" dataKey="cooling" stroke="#E10600" strokeWidth={2} dot={false} name="Cooling (kW)" />
                                <Line type="monotone" dataKey="process" stroke="#FF5A00" strokeWidth={2} dot={false} name="Load (kW)" />
                                <Line type="monotone" dataKey="return" stroke="#FFD400" strokeWidth={2} dot={false} name="Safe Shift (kW)" />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>

                    {/* B. DERIVED EFFICIENCY */}
                    <div>
                        <h2 className="text-lg font-semibold text-[#FF5A00] mb-4 flex items-center gap-2">
                            <TrendingUp className="w-5 h-5" />
                            Derived Efficiency (Near Real-time)
                        </h2>

                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                            {efficiencyMetrics.map((metric, idx) => {
                                const col = getStatusColor(metric.status);
                                const pct = clamp((metric.value / metric.target) * 100, 0, 100);

                                return (
                                    <div key={idx} className="bg-gradient-to-br from-[#120805] to-[#1A0B06] border border-[#5A2A14] rounded-lg p-4">
                                        <div className="mb-3">
                                            <div className="text-sm text-[#7A3A1A] mb-1">{metric.metric}</div>
                                            <div className="text-2xl font-bold text-[#FFB800]">{metric.value}</div>
                                            <div className="text-xs text-[#5A2A14]">Target: {metric.target}</div>
                                        </div>

                                        <div className="w-full bg-[#1A0B06] rounded-full h-1.5">
                                            <div
                                                className="h-1.5 rounded-full transition-all duration-700"
                                                style={{
                                                    width: `${pct}%`,
                                                    backgroundColor: col,
                                                    boxShadow: `0 0 8px ${col}60`,
                                                }}
                                            />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* C. ENVIRONMENTAL IMPACT */}
                    <div>
                        <h2 className="text-lg font-semibold text-[#FFD400] mb-4 flex items-center gap-2">
                            <CloudRain className="w-5 h-5" />
                            Environmental Impact (Strategic)
                        </h2>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                            <div className="bg-gradient-to-br from-[#120805] to-[#1A0B06] border border-[#3A1A0A] rounded-lg p-6 shadow-xl">
                                <h3 className="text-sm font-semibold text-[#FFE65C] mb-4">
                                    Carbon Intensity (gCO₂/kWh)
                                </h3>

                                <ResponsiveContainer width="100%" height={220}>
                                    <AreaChart data={carbonData}>
                                        <defs>
                                            <linearGradient id="carbonGradient" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#FFD400" stopOpacity={0.3} />
                                                <stop offset="95%" stopColor="#FF5A00" stopOpacity={0} />
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#3A1A0A" />
                                        <XAxis dataKey="time" stroke="#7A3A1A" style={{ fontSize: 12 }} />
                                        <YAxis stroke="#7A3A1A" style={{ fontSize: 12 }} />
                                        <Tooltip
                                            contentStyle={{ backgroundColor: '#120805', border: '1px solid #5A2A14', borderRadius: 8 }}
                                            labelStyle={{ color: '#FFE65C' }}
                                        />
                                        <Area type="monotone" dataKey="intensity" stroke="#FFD400" fill="url(#carbonGradient)" strokeWidth={2} />
                                    </AreaChart>
                                </ResponsiveContainer>

                                {kpi && (
                                    <div className="mt-4 grid grid-cols-2 gap-3">
                                        <div className="p-2 bg-[#1A0B06] rounded border border-[#3A1A0A] text-center">
                                            <div className="text-xs text-[#7A3A1A] mb-1">CO₂ Avoided</div>
                                            <div className="text-lg font-bold text-[#FFD400]">
                                                {kpi.co2_avoided_kg.toFixed(1)} <span className="text-xs">kg</span>
                                            </div>
                                        </div>
                                        <div className="p-2 bg-[#1A0B06] rounded border border-[#3A1A0A] text-center">
                                            <div className="text-xs text-[#7A3A1A] mb-1">Money Saved</div>
                                            <div className="text-lg font-bold text-[#FFB800]">
                                                ${kpi.money_saved_usd.toFixed(0)}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="bg-gradient-to-br from-[#120805] to-[#1A0B06] border border-[#3A1A0A] rounded-lg p-6 shadow-xl">
                                <h3 className="text-sm font-semibold text-[#FFE65C] mb-4">Performance Forecast</h3>

                                <ResponsiveContainer width="100%" height={280}>
                                    <RadarChart data={predictionRadar}>
                                        <PolarGrid stroke="#3A1A0A" />
                                        <PolarAngleAxis dataKey="metric" stroke="#7A3A1A" style={{ fontSize: 11 }} />
                                        <PolarRadiusAxis stroke="#5A2A14" />
                                        <Radar name="Current" dataKey="current" stroke="#FFD400" fill="#FFD400" fillOpacity={0.3} strokeWidth={2} />
                                        <Radar name="Forecast" dataKey="forecast" stroke="#E10600" fill="#E10600" fillOpacity={0.2} strokeWidth={2} strokeDasharray="5 5" />
                                        <Legend wrapperStyle={{ fontSize: 12 }} />
                                    </RadarChart>
                                </ResponsiveContainer>
                            </div>
                        </div>
                    </div>

                    {/* D. RISK / PREDICTION */}
                    <div>
                        <h2 className="text-lg font-semibold text-[#E10600] mb-4 flex items-center gap-2">
                            <AlertTriangle className="w-5 h-5" />
                            Risk & Prediction (Forecasting)
                        </h2>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                            <div className="bg-gradient-to-br from-[#120805] to-[#1A0B06] border border-[#3A1A0A] rounded-lg p-6 shadow-xl">
                                <h3 className="text-sm font-semibold text-[#FFE65C] mb-4">Time to Failure (hours)</h3>
                                <div className="space-y-3">
                                    {riskMetrics.map((risk, idx) => (
                                        <div key={idx} className="p-3 bg-[#1A0B06] rounded border border-[#3A1A0A]">
                                            <div className="flex justify-between items-center mb-2">
                                                <span className="text-sm text-[#FFE65C]">{risk.component}</span>
                                                <span
                                                    className={`text-xs px-2 py-1 rounded ${risk.exceedance > 30
                                                        ? 'bg-[#E10600]/20 text-[#E10600]'
                                                        : risk.exceedance > 10
                                                            ? 'bg-[#FF5A00]/20 text-[#FF5A00]'
                                                            : 'bg-[#FFD400]/20 text-[#FFD400]'
                                                        }`}
                                                >
                                                    {risk.exceedance}% risk
                                                </span>
                                            </div>
                                            <div className="flex items-baseline gap-2">
                                                <span className="text-xl font-bold text-[#FFB800]">{risk.ttf}</span>
                                                <span className="text-xs text-[#5A2A14]">hrs • {risk.forecast}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* System Advisory */}
                            <div className="bg-gradient-to-r from-[#E10600]/10 to-[#FF5A00]/10 border border-[#E10600]/40 rounded-lg p-6 shadow-lg">
                                <div className="flex items-start gap-3">
                                    <AlertTriangle className="w-5 h-5 text-[#FFD400] flex-shrink-0 mt-0.5" style={{ filter: 'drop-shadow(0 0 6px rgba(255, 212, 0, 0.6))' }} />
                                    <div>
                                        <h3 className="font-semibold text-[#FFB800] mb-1">System Advisory</h3>
                                        <p className="text-sm text-[#FFE65C]">
                                            Safe shift headroom is{' '}
                                            <span className="font-mono">{(latest?.safe_shift_kw ?? 0).toFixed(0)} kW</span>.{' '}
                                            If this drops under 900 kW, throttle workload shifting.
                                        </p>
                                        {kpi && (
                                            <p className="text-xs text-[#7A3A1A] mt-3">
                                                Blocked rate: {kpi.blocked_rate_pct.toFixed(1)}% • On-time jobs: {kpi.jobs_completed_on_time_pct.toFixed(1)}%
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}

