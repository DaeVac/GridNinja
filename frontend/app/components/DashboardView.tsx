'use client';

import React from 'react';
import Image from 'next/image';
import { useTelemetryWS } from '@/lib/telemetry/useTelemetryWS';
import clsx from 'clsx';
import { Activity, Gauge, Zap, DollarSign, Leaf, ShieldAlert } from 'lucide-react';
import LogoutButton from '../../components/LogoutButton';
import dynamic from 'next/dynamic';
import { KpiGrid } from '../../components/kpi/KpiGrid';
import { KpiCardProps } from '../../components/kpi/KpiCard';
import DemoModeButton from './DemoModeButton';
import LoadShiftPanel from './LoadShiftPanel';

// Backend API
const API_BASE =
    "/api";
const WS_BASE =
    (process.env.NEXT_PUBLIC_WS_BASE_URL ?? "ws://localhost:8000").replace(/\/+$/, "");

const DEMO_KPIS: KpiCardProps[] = [
    {
        title: "Money Saved",
        value: 18432.75,
        format: "currency",
        decimals: 2,
        subtitle: "vs baseline (last 1h)",
        status: "allowed",
        tone: "good",
        icon: <DollarSign size={18} />,
    },
    {
        title: "Carbon Reduced",
        value: 1268.4,
        format: "co2_kg",
        decimals: 1,
        subtitle: "avoided emissions",
        status: "allowed",
        tone: "good",
        icon: <Leaf size={18} />,
    },
    {
        title: "Actions Blocked",
        value: 7,
        format: "number",
        decimals: 0,
        subtitle: "safety violations",
        status: "blocked",
        tone: "bad",
        icon: <ShieldAlert size={18} />,
    },
    {
        title: "SLA Penalty Avoided",
        value: 3200,
        format: "currency",
        decimals: 0,
        subtitle: "potential fines",
        status: "mixed",
        tone: "warn",
        icon: <Zap size={18} />,
    },
];

const GridVisualizer = dynamic(() => import('./GridVisualizer'), {
    ssr: false,
    loading: () => (
        <div className="h-full w-full flex items-center justify-center bg-[#0B0705] text-[#7A3A1A] text-xs">
            Loading Grid...
        </div>
    ),
});
const LOGO_WIDTH = 160;
const LOGO_HEIGHT = 40;
const AVATAR_SIZE = 36;

// User Profile type (compatible with Auth0 User)
interface UserProfile {
    name?: string;
    picture?: string;
    email?: string;
}


export default function DashboardView({ user }: { user: UserProfile }) {
    const { status, transport, latest } = useTelemetryWS();
    const [kpis, setKpis] = React.useState<KpiCardProps[]>(DEMO_KPIS);
    const [loadingKpi, setLoadingKpi] = React.useState(true);
    const hasLoadedRef = React.useRef(false);
    const avatarSrc = user.picture ?? "/tempLogo.svg";
    const avatarAlt = user.name ? `${user.name} profile` : "Operator profile";
    const isLocalAvatar = avatarSrc.startsWith("/");
    const lastTelemetryTs = latest?.ts ?? "n/a";

    // Fetch KPIs every 5s
    React.useEffect(() => {
        let alive = true;

        const fetchKpis = async () => {
            const showLoading = !hasLoadedRef.current;
            if (showLoading) setLoadingKpi(true);
            try {
                const res = await fetch(`${API_BASE}/kpi/summary?window_s=3600`, { cache: 'no-store' });
                if (!res.ok) throw new Error(`KPI summary failed: ${res.status}`);
                const data = await res.json();
                if (!alive) return;

                const newKpis: KpiCardProps[] = [
                    {
                        title: "Money Saved",
                        value: data.money_saved_usd,
                        format: "currency",
                        decimals: 2,
                        subtitle: "vs baseline (last 1h)",
                        status: "allowed",
                        tone: "good",
                        icon: <DollarSign size={18} />,
                    },
                    {
                        title: "Carbon Reduced",
                        value: data.co2_avoided_kg,
                        format: "co2_kg",
                        decimals: 1,
                        subtitle: "avoided emissions",
                        status: "allowed",
                        tone: "good",
                        icon: <Leaf size={18} />,
                    },
                    {
                        title: "Actions Blocked",
                        value: data.unsafe_actions_prevented_total,
                        format: "number",
                        decimals: 0,
                        subtitle: "safety violations",
                        status: data.unsafe_actions_prevented_total > 0 ? "blocked" : "neutral",
                        tone: data.unsafe_actions_prevented_total > 0 ? "bad" : "neutral",
                        icon: <ShieldAlert size={18} />,
                    },
                    {
                        title: "SLA Penalty Avoided",
                        value: data.sla_penalty_usd ?? 0,
                        format: "currency",
                        decimals: 0,
                        subtitle: "potential fines",
                        status: "mixed",
                        tone: "warn",
                        icon: <Zap size={18} />,
                    }
                ];
                const hasLiveData = [
                    data.money_saved_usd,
                    data.co2_avoided_kg,
                    data.unsafe_actions_prevented_total,
                    data.sla_penalty_usd ?? 0,
                ].some((value) => Number.isFinite(value) && value !== 0);
                setKpis(hasLiveData ? newKpis : DEMO_KPIS);
                hasLoadedRef.current = true;
            } catch (err) {
                console.error("Failed to fetch KPIs", err);
                if (!alive) return;
                if (!hasLoadedRef.current) {
                    setKpis(DEMO_KPIS);
                }
            } finally {
                if (!alive) return;
                if (showLoading) setLoadingKpi(false);
            }
        };

        fetchKpis();
        const interval = setInterval(fetchKpis, 5000);
        return () => {
            alive = false;
            clearInterval(interval);
        };
    }, []);

    return (
        <div className="flex flex-col min-h-screen w-full bg-[#120805] text-slate-100 font-sans">
            {/* --- Header --- */}
            <header className="bg-[#120805] border-b border-[#3A1A0A] px-4 py-3 sticky top-0 z-30 shadow-lg">
                <nav aria-label="Mission Control" className="w-full max-w-7xl mx-auto flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="flex flex-wrap items-center gap-3">
                        <Image
                            src="/teamName.svg"
                            alt="GridNinja"
                            width={LOGO_WIDTH}
                            height={LOGO_HEIGHT}
                            priority
                            sizes="(max-width: 640px) 140px, 160px"
                            className="h-7 w-auto sm:h-8"
                        />
                        <div className="hidden sm:block h-6 w-px bg-[#3A1A0A]" />
                        <h1 className="text-lg sm:text-xl font-bold bg-gradient-to-r from-[#FFD400] via-[#FF5A00] to-[#E10600] bg-clip-text text-transparent">
                            Mission Control
                        </h1>
                        <div className="hidden sm:block h-6 w-px bg-[#3A1A0A]" />
                        <a
                            href="/digital-twin"
                            className="inline-flex items-center gap-2 rounded-full border border-[#E10600]/30 bg-[#120805] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#FFE65C] transition hover:border-[#E10600]/60 hover:text-white"
                        >
                            Digital Twin {"->"}
                        </a>
                    </div>

                    <div className="flex flex-wrap items-center gap-4">
                        {/* Live Telemetry Pill */}
                        <div className="flex items-center gap-3 bg-[#120805] px-3 py-1.5 rounded-full border border-[#E10600]/30" aria-live="polite">
                            <div className="flex items-center gap-2 text-[10px] font-semibold text-[#7A3A1A] uppercase tracking-[0.2em]">
                                <Activity className="w-3.5 h-3.5" />
                                System Status
                            </div>
                            <div className={clsx(
                                "flex items-center gap-1.5 text-xs font-bold px-2 py-0.5 rounded-md",
                                status === 'open' ? "bg-[#E10600]/20 text-[#FFE65C]" :
                                    status === 'connecting' ? "bg-[#FF5A00]/20 text-[#FFB800]" :
                                        "bg-[#E10600]/30 text-[#E10600]"
                            )}>
                                <div className={clsx("w-2 h-2 rounded-full", status === 'open' ? "bg-[#E10600] animate-pulse" : "bg-current")} />
                                {status === 'open' ? 'ONLINE' : status.toUpperCase()}
                            </div>
                            <div className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-[#120805] border border-[#3A1A0A] text-[#FFE65C]">
                                {(transport ?? "ws").toUpperCase()}
                            </div>
                        </div>
                        <DemoModeButton />

                        {/* Quick Stats */}
                        {latest && (
                            <div className="hidden md:flex items-center gap-6 text-xs">
                                <div className="flex flex-col items-end leading-tight">
                                    <span className="text-[10px] text-[#7A3A1A] font-medium uppercase tracking-[0.2em]">Frequency</span>
                                    <span className={clsx("font-bold", latest.frequency_hz < 59.95 ? "text-[#E10600]" : "text-[#FFE65C]")}>
                                        {latest.frequency_hz.toFixed(3)} Hz
                                    </span>
                                </div>
                                <div className="flex flex-col items-end leading-tight">
                                    <span className="text-[10px] text-[#7A3A1A] font-medium uppercase tracking-[0.2em]">Total Load</span>
                                    <span className="font-bold text-[#FFE65C]">{latest.total_load_kw.toFixed(0)} kW</span>
                                </div>
                            </div>
                        )}

                        <div className="hidden sm:block h-6 w-px bg-[#3A1A0A]" />

                        <div className="flex items-center gap-3">
                            <div className="text-right hidden sm:block">
                                <div className="text-sm font-semibold text-[#FFE65C]">{user.name}</div>
                                <div className="text-[10px] uppercase tracking-[0.2em] text-[#7A3A1A]">Operator</div>
                            </div>
                            {isLocalAvatar ? (
                                <Image
                                    src={avatarSrc}
                                    alt={avatarAlt}
                                    width={AVATAR_SIZE}
                                    height={AVATAR_SIZE}
                                    className="h-9 w-9 rounded-full border border-[#3A1A0A] object-cover"
                                />
                            ) : (
                                <img
                                    src={avatarSrc}
                                    alt={avatarAlt}
                                    width={AVATAR_SIZE}
                                    height={AVATAR_SIZE}
                                    loading="lazy"
                                    referrerPolicy="no-referrer"
                                    className="h-9 w-9 rounded-full border border-[#3A1A0A] object-cover"
                                />
                            )}
                            <LogoutButton variant="compact" />
                        </div>
                    </div>
                </nav>
            </header>

            {/* --- Main Content --- */}
            <main className="flex-1 min-h-0 p-4 sm:p-6 relative overflow-y-auto scrollbar-twin">
                <div className="w-full max-w-7xl mx-auto flex flex-col gap-6 pb-8">
                    {/* Debug Banner */}
                    <div className="bg-[#120805]/80 border border-[#3A1A0A] rounded-lg px-4 py-2 text-[10px] font-mono text-[#FFE65C] flex flex-wrap gap-3 shadow-sm">
                        <span className="text-[#7A3A1A] uppercase tracking-[0.2em] font-semibold">Debug</span>
                        <span>API: {API_BASE}</span>
                        <span>WS: {WS_BASE}</span>
                        <span>Last TS: {lastTelemetryTs}</span>
                    </div>
                    {/* KPI Section */}
                    <section aria-labelledby="performance-metrics-title">
                        <h2 id="performance-metrics-title" className="text-lg font-semibold text-[#FFE65C] mb-3">
                            Performance Metrics
                        </h2>
                        <KpiGrid items={kpis} isLoading={loadingKpi} columns={4} layout="row" />
                    </section>

                    {/* Visualizers Grid */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                        {/* Left: Network Topology */}
                        <section aria-labelledby="grid-topology-title" className="flex flex-col gap-3">
                            <div className="flex items-center justify-between">
                                <h2 id="grid-topology-title" className="text-lg font-semibold flex items-center gap-2 text-[#FFB800]">
                                    <Zap className="w-5 h-5 text-[#FFB800]" />
                                    Grid Topology
                                </h2>
                                <span className="text-xs font-mono text-[#7A3A1A]">IEEE-33 BUS SYSTEM</span>
                            </div>
                            <div className="relative isolate h-[320px] sm:h-[360px] lg:h-[460px] bg-[#0B0705] rounded-xl border border-[#3A1A0A] shadow-xl overflow-hidden">
                                <GridVisualizer telemetry={latest} />
                            </div>
                        </section>

                        {/* Right: Shift Control */}
                        <section aria-labelledby="shift-control-title" className="flex flex-col gap-3">
                            <div className="flex items-center justify-between">
                                <h2 id="shift-control-title" className="text-lg font-semibold flex items-center gap-2 text-[#FFE65C]">
                                    <Gauge className="w-5 h-5 text-[#FF5A00]" />
                                    Shift Control Plane
                                </h2>
                                <span className="text-xs font-mono text-[#7A3A1A]">LIVE CONSTRAINTS</span>
                            </div>
                            <LoadShiftPanel telemetry={latest} />
                        </section>
                    </div>
                </div>
            </main>
        </div>
    );
}

