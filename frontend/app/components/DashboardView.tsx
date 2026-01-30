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

type DecisionLogEntry = {
    decision_id: string;
    ts: string;
    requested_kw: number;
    approved_kw: number;
    blocked: boolean;
    reason_code: string;
    primary_constraint?: string | null;
    constraint_value?: number | null;
    constraint_threshold?: number | null;
    confidence?: number | null;
    count?: number | null;
    first_ts?: string | null;
    last_ts?: string | null;
};

const DECISION_LOG_LIMIT = 20;
const DECISION_LOG_POLL_MS = 10000;

function formatSignedKw(value: number | null | undefined) {
    if (!Number.isFinite(value)) return 'n/a';
    const sign = (value ?? 0) > 0 ? '+' : '';
    return `${sign}${Number(value).toFixed(0)} kW`;
}

function formatMaybeNumber(value: number | null | undefined, digits = 2) {
    if (!Number.isFinite(value)) return 'n/a';
    return Number(value).toFixed(digits);
}

function formatShortTime(iso: string | null | undefined) {
    if (!iso) return 'n/a';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

type DecisionOutcome = 'allowed' | 'clipped' | 'blocked';
type GroupingMode = 'off' | 'reason' | 'window';

const COALESCE_WINDOW_S = 90;
const THERMAL_MAX_C = 50;

function outcomeFor(entry: DecisionLogEntry): DecisionOutcome {
    if (entry.blocked) return 'blocked';
    const clipped = Math.abs(entry.approved_kw) + 1e-6 < Math.abs(entry.requested_kw);
    return clipped ? 'clipped' : 'allowed';
}

function formatOutcomeLabel(outcome: DecisionOutcome) {
    return outcome === 'blocked' ? 'BLOCKED' : outcome === 'clipped' ? 'CLIPPED' : 'ALLOWED';
}

function marginLabel(entry: DecisionLogEntry) {
    if (!Number.isFinite(entry.constraint_value) || !Number.isFinite(entry.constraint_threshold)) return 'n/a';
    const margin = Number(entry.constraint_threshold) - Number(entry.constraint_value);
    const sign = margin >= 0 ? '+' : '';
    return `${sign}${margin.toFixed(2)}`;
}

function nextCheckInSeconds(entry: DecisionLogEntry, latestTempC?: number) {
    if ((entry.primary_constraint ?? '').toUpperCase() !== 'THERMAL') return null;
    if (Number.isFinite(entry.constraint_value) && Number.isFinite(entry.constraint_threshold)) {
        const diff = Number(entry.constraint_threshold) - Number(entry.constraint_value);
        if (diff >= 0) return 30;
        const secs = Math.ceil(Math.abs(diff) / 0.02);
        return Math.min(300, Math.max(30, secs));
    }
    if (Number.isFinite(latestTempC)) {
        const diff = THERMAL_MAX_C - Number(latestTempC);
        if (diff >= 0) return 45;
        const secs = Math.ceil(Math.abs(diff) / 0.02);
        return Math.min(300, Math.max(30, secs));
    }
    return 90;
}

export default function DashboardView({ user }: { user: UserProfile }) {
    const { status, transport, latest, buffer } = useTelemetryWS();
    const [kpis, setKpis] = React.useState<KpiCardProps[]>(DEMO_KPIS);
    const [loadingKpi, setLoadingKpi] = React.useState(true);
    const [decisionLog, setDecisionLog] = React.useState<DecisionLogEntry[]>([]);
    const [decisionLogError, setDecisionLogError] = React.useState<string | null>(null);
    const [filterOutcome, setFilterOutcome] = React.useState<DecisionOutcome | 'all'>('all');
    const [grouping, setGrouping] = React.useState<GroupingMode>('off');
    const [searchTerm, setSearchTerm] = React.useState('');
    const [onlyStateChanges, setOnlyStateChanges] = React.useState(false);
    const [expandedGroups, setExpandedGroups] = React.useState<Record<string, boolean>>({});
    const [selectedRowId, setSelectedRowId] = React.useState<string | null>(null);
    const tableScrollRef = React.useRef<HTMLDivElement | null>(null);
    const [scrollTop, setScrollTop] = React.useState(0);
    const hasLoadedRef = React.useRef(false);
    const avatarSrc = user.picture ?? "/tempLogo.svg";
    const avatarAlt = user.name ? `${user.name} profile` : "Operator profile";
    const isLocalAvatar = avatarSrc.startsWith("/");
    const lastTelemetryTs = latest?.ts ?? "n/a";
    const latestDecision = decisionLog[0] ?? null;
    const latestTempC = latest?.rack_temp_c;

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

    const coalescedRows = React.useMemo(() => {
        const hasBackendCoalesce = decisionLog.some((entry) => {
            return (entry.count && entry.count > 1) || entry.first_ts || entry.last_ts;
        });

        const sorted = [...decisionLog].sort((a, b) => {
            const ta = new Date(a.ts).getTime();
            const tb = new Date(b.ts).getTime();
            return tb - ta;
        });

        if (hasBackendCoalesce) {
            return sorted.map((entry) => ({
                id: entry.decision_id,
                count: entry.count ?? 1,
                first_ts: entry.first_ts ?? entry.ts,
                last_ts: entry.last_ts ?? entry.ts,
                entries: [entry],
                outcome: outcomeFor(entry),
                reason_code: entry.reason_code,
                requested_kw: entry.requested_kw,
            }));
        }

        const rows: Array<{
            id: string;
            count: number;
            first_ts: string;
            last_ts: string;
            entries: DecisionLogEntry[];
            outcome: DecisionOutcome;
            reason_code: string;
            requested_kw: number;
        }> = [];

        for (const entry of sorted) {
            const outcome = outcomeFor(entry);
            if (outcome !== 'blocked') {
                rows.push({
                    id: entry.decision_id,
                    count: 1,
                    first_ts: entry.ts,
                    last_ts: entry.ts,
                    entries: [entry],
                    outcome,
                    reason_code: entry.reason_code,
                    requested_kw: entry.requested_kw,
                });
                continue;
            }

            const last = rows[rows.length - 1];
            const sameReason = last && last.outcome === 'blocked' && last.reason_code === entry.reason_code;
            const sameRequest = last && Math.abs(last.requested_kw - entry.requested_kw) < 1e-3;
            const deltaT = last
                ? Math.abs(new Date(last.last_ts).getTime() - new Date(entry.ts).getTime()) / 1000
                : Infinity;
            if (last && sameReason && sameRequest && deltaT <= COALESCE_WINDOW_S) {
                last.count += 1;
                last.entries.push(entry);
                last.first_ts = entry.ts;
            } else {
                rows.push({
                    id: entry.decision_id,
                    count: 1,
                    first_ts: entry.ts,
                    last_ts: entry.ts,
                    entries: [entry],
                    outcome,
                    reason_code: entry.reason_code,
                    requested_kw: entry.requested_kw,
                });
            }
        }

        return rows;
    }, [decisionLog]);

    const filteredRows = React.useMemo(() => {
        const term = searchTerm.trim().toLowerCase();
        const base = coalescedRows.filter((row) => {
            const entry = row.entries[0];
            const outcome = row.outcome;
            if (filterOutcome !== 'all' && outcome !== filterOutcome) return false;
            if (!term) return true;
            const hay = [
                entry.decision_id,
                entry.reason_code,
                entry.primary_constraint ?? '',
                String(entry.requested_kw),
                String(entry.approved_kw),
            ]
                .join(' ')
                .toLowerCase();
            return hay.includes(term);
        });

        if (!onlyStateChanges) return base;

        const out: typeof base = [];
        let lastOutcome: DecisionOutcome | null = null;
        for (const row of base) {
            if (row.outcome !== lastOutcome) {
                out.push(row);
                lastOutcome = row.outcome;
            }
        }
        return out;
    }, [coalescedRows, filterOutcome, searchTerm, onlyStateChanges]);

    const groupedRows = React.useMemo(() => {
        if (grouping === 'off') return filteredRows;
        const groups = new Map<string, typeof filteredRows>();
        filteredRows.forEach((row) => {
            const entry = row.entries[0];
            let key = '';
            if (grouping === 'reason') {
                key = `${row.outcome}:${entry.reason_code}`;
            } else {
                const t = new Date(entry.ts).getTime();
                const window = Math.floor(t / (5 * 60 * 1000));
                key = `win:${window}`;
            }
            const arr = groups.get(key) ?? [];
            arr.push(row);
            groups.set(key, arr);
        });

        const grouped = Array.from(groups.values()).map((rows) => {
            const first = rows[0];
            const entries = rows.flatMap((r) => r.entries);
            const count = entries.length;
            return {
                ...first,
                id: `group:${first.id}`,
                count,
                first_ts: rows[rows.length - 1]?.first_ts ?? first.first_ts,
                last_ts: first.last_ts,
                entries,
            };
        });
        return grouped;
    }, [filteredRows, grouping]);

    const selectedRow = React.useMemo(() => {
        if (!selectedRowId) return null;
        return groupedRows.find((row) => row.id === selectedRowId) ?? null;
    }, [groupedRows, selectedRowId]);

    const summary = React.useMemo(() => {
        const blockedCount = coalescedRows
            .filter((r) => r.outcome === 'blocked')
            .reduce((sum, r) => sum + r.count, 0);
        const lastAllowed = coalescedRows.find((r) => r.outcome === 'allowed' || r.outcome === 'clipped');
        const current = coalescedRows[0];
        const currentState = current
            ? `${current.outcome.toUpperCase()} ${current.entries[0].primary_constraint ?? current.reason_code}`
            : 'NO DATA';
        const nextCheck = current && current.outcome === 'blocked'
            ? nextCheckInSeconds(current.entries[0], latestTempC)
            : null;
        return {
            currentState,
            blockedCount,
            lastAllowed,
            nextCheck,
        };
    }, [coalescedRows, latestTempC]);

    const rowHeight = 52;
    const viewportHeight = 320;
    const virtualizationEnabled = groupedRows.length > 0 && !Object.values(expandedGroups).some(Boolean);
    const visibleRange = React.useMemo(() => {
        if (!virtualizationEnabled) {
            return { start: 0, end: groupedRows.length };
        }
        const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 2);
        const visibleCount = Math.ceil(viewportHeight / rowHeight) + 4;
        const end = Math.min(groupedRows.length, start + visibleCount);
        return { start, end };
    }, [virtualizationEnabled, groupedRows.length, scrollTop]);

    const visibleRows = virtualizationEnabled
        ? groupedRows.slice(visibleRange.start, visibleRange.end)
        : groupedRows;
    const sparkline = React.useMemo(() => {
        const points = buffer.slice(-120);
        if (!points.length) return null;
        const thermal = points.map((p) => THERMAL_MAX_C - (p.rack_temp_c ?? 0));
        const headroom = points.map((p) => p.safe_shift_kw ?? 0);
        const width = 320;
        const height = 56;
        const pad = 6;

        const buildPolyline = (vals: number[], color: string) => {
            const min = Math.min(...vals);
            const max = Math.max(...vals);
            const range = max - min || 1;
            const pts = vals.map((v, i) => {
                const x = pad + (i / (vals.length - 1)) * (width - pad * 2);
                const y = pad + (1 - (v - min) / range) * (height - pad * 2);
                return `${x},${y}`;
            });
            return { points: pts.join(' '), color };
        };

        return {
            width,
            height,
            lines: [
                buildPolyline(thermal, '#FFB800'),
                buildPolyline(headroom, '#22c55e'),
            ],
        };
    }, [buffer]);
    React.useEffect(() => {
        let alive = true;

        const fetchDecisionLog = async () => {
            try {
                const res = await fetch(`${API_BASE}/decision/recent?limit=${DECISION_LOG_LIMIT}&coalesce=true&window_s=${COALESCE_WINDOW_S}`, { cache: 'no-store' });
                if (!res.ok) throw new Error(`Decision log failed: ${res.status}`);
                const data = await res.json();
                if (!alive) return;
                const items = Array.isArray(data?.items) ? data.items : [];
                setDecisionLog(items);
                setDecisionLogError(null);
            } catch (err) {
                console.error("Failed to fetch decision log", err);
                if (!alive) return;
                setDecisionLogError('Decision log unavailable');
            }
        };

        fetchDecisionLog();
        const interval = window.setInterval(fetchDecisionLog, DECISION_LOG_POLL_MS);
        return () => {
            alive = false;
            window.clearInterval(interval);
        };
    }, []);

    return (
        <div className="flex flex-col min-h-screen w-full bg-[#120805] text-slate-100 font-sans">
            {/* --- Header --- */}
            <header className="bg-[#120805] border-b border-[#3A1A0A] py-3 sticky top-0 z-30 shadow-lg">
                <nav aria-label="Mission Control" className="w-full max-w-[1600px] mx-auto px-4 sm:px-6 2xl:px-10 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
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
                                <div className={clsx("w-2 h-2 rounded-full", status === 'open' ? "bg-[#E10600] animate-pulse-slow" : "bg-current")} />
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
                <div className="w-full max-w-[1600px] mx-auto flex flex-col gap-6 pb-8">
                    {/* Debug Banner */}
                    {process.env.NODE_ENV === 'development' && (
                        <div className="bg-[#120805]/80 border border-[#3A1A0A] rounded-lg px-4 py-2 text-[10px] font-mono text-[#FFE65C] flex flex-wrap gap-3 shadow-sm">
                            <span className="text-[#7A3A1A] uppercase tracking-[0.2em] font-semibold">Debug</span>
                            <span>API: {API_BASE}</span>
                            <span>WS: {WS_BASE}</span>
                            <span>Last TS: {lastTelemetryTs}</span>
                        </div>
                    )}
                    {/* KPI Section */}
                    <section aria-labelledby="performance-metrics-title">
                        <h2 id="performance-metrics-title" className="text-lg font-semibold text-[#FFE65C] mb-3">
                            Performance Metrics
                        </h2>
                        <KpiGrid items={kpis} isLoading={loadingKpi} columns={4} />
                    </section>

                    {/* Mission Control Grid */}
                    <div className="grid grid-cols-12 gap-6">

                        {/* Topology: 8/12 */}
                        <section
                            aria-labelledby="grid-topology-title"
                            className="col-span-12 lg:col-span-8 flex flex-col gap-3"
                        >
                            <div className="flex items-center justify-between">
                                <h2 id="grid-topology-title" className="text-lg font-semibold flex items-center gap-2 text-[#FFB800]">
                                    <Zap className="w-5 h-5 text-[#FFB800]" />
                                    Grid Topology
                                </h2>
                                <span className="text-xs font-mono text-[#7A3A1A]">IEEE-33 BUS SYSTEM</span>
                            </div>
                            <div id="gridviz" className="relative isolate h-[380px] sm:h-[460px] 2xl:h-[560px] bg-[#0B0705] rounded-xl border border-[#3A1A0A] shadow-xl overflow-hidden">
                                <GridVisualizer telemetry={latest} />
                            </div>
                        </section>

                        {/* Sidebar: 4/12 */}
                        <aside className="col-span-12 lg:col-span-4 flex flex-col gap-3">
                            <div className="flex items-center justify-between">
                                <h2 className="text-lg font-semibold flex items-center gap-2 text-[#FFE65C]">
                                    <Gauge className="w-5 h-5 text-[#FF5A00]" />
                                    Action Console
                                </h2>
                                <span className="text-xs font-mono text-[#7A3A1A]">LIVE</span>
                            </div>
                            <LoadShiftPanel telemetry={latest} />
                            <div className="rounded-xl border border-[#3A1A0A] bg-[#0B0705] p-4">
                                <div className="text-[10px] uppercase tracking-[0.2em] text-[#7A3A1A] font-semibold">
                                    Limiting Constraint
                                </div>
                                <div className="mt-2 flex items-center justify-between gap-2">
                                    <div className="text-sm font-semibold text-[#FFE65C]">
                                        {latestDecision?.primary_constraint ?? 'n/a'}
                                    </div>
                                    <span className={clsx(
                                        "text-[10px] font-semibold uppercase tracking-[0.2em] px-2 py-1 rounded border",
                                        latestDecision
                                            ? (latestDecision.blocked
                                                ? "border-[#E10600]/60 text-[#E10600]"
                                                : "border-[#FF5A00]/50 text-[#FFE65C]")
                                            : "border-[#3A1A0A] text-[#7A3A1A]"
                                    )}>
                                        {latestDecision ? (latestDecision.blocked ? 'BLOCKED' : 'ALLOWED') : 'NO DATA'}
                                    </span>
                                </div>
                                <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-[#FFE65C]">
                                    <div className="rounded-md border border-[#3A1A0A] bg-[#120805]/70 px-2 py-1">
                                        <div className="text-[9px] uppercase tracking-[0.2em] text-[#7A3A1A]">Value</div>
                                        <div className="mt-1 font-mono">{formatMaybeNumber(latestDecision?.constraint_value, 2)}</div>
                                    </div>
                                    <div className="rounded-md border border-[#3A1A0A] bg-[#120805]/70 px-2 py-1">
                                        <div className="text-[9px] uppercase tracking-[0.2em] text-[#7A3A1A]">Threshold</div>
                                        <div className="mt-1 font-mono">{formatMaybeNumber(latestDecision?.constraint_threshold, 2)}</div>
                                    </div>
                                </div>
                                <div className="mt-2 text-xs text-slate-300">
                                    {latestDecision
                                        ? `Reason: ${latestDecision.reason_code}`
                                        : 'Awaiting decisions from the controller.'}
                                </div>
                                <div className="mt-1 text-[10px] font-mono text-[#7A3A1A]">
                                    {latestDecision ? `Last decision at ${formatShortTime(latestDecision.ts)}` : 'No recent decisions'}
                                </div>
                            </div>
                        </aside>

                        {/* Shift Control Plane: full width below */}
                        <section
                            aria-labelledby="shift-control-title"
                            className="col-span-12 flex flex-col gap-3"
                        >
                            <div className="flex items-center justify-between">
                                <h2 id="shift-control-title" className="text-lg font-semibold flex items-center gap-2 text-[#FFE65C]">
                                    <Gauge className="w-5 h-5 text-[#FF5A00]" />
                                    Shift Control Plane
                                </h2>
                                <span className="text-xs font-mono text-[#7A3A1A]">LIVE CONSTRAINTS</span>
                            </div>
                            <div className="rounded-xl border border-[#3A1A0A] bg-[#0B0705] p-4">
                                <div className="text-[10px] uppercase tracking-[0.2em] text-[#7A3A1A] font-semibold">
                                    Decision Log
                                </div>
                                <div className="mt-3 flex flex-col gap-3">
                                    <div className="rounded-lg border border-[#3A1A0A] bg-[#120805]/80 px-3 py-2 text-[10px] text-[#FFE65C]">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <div className="text-[9px] uppercase tracking-[0.2em] text-[#7A3A1A]">Current state</div>
                                            <div className="font-mono">{summary.currentState}</div>
                                            <div className="text-[9px] uppercase tracking-[0.2em] text-[#7A3A1A]">Blocked attempts</div>
                                            <div className="font-mono">{summary.blockedCount}</div>
                                            <div className="text-[9px] uppercase tracking-[0.2em] text-[#7A3A1A]">Last success</div>
                                            <div className="font-mono">
                                                {summary.lastAllowed
                                                    ? `${formatSignedKw(summary.lastAllowed.entries[0].approved_kw)} @ ${formatShortTime(summary.lastAllowed.last_ts)}`
                                                    : 'n/a'}
                                            </div>
                                            <div className="text-[9px] uppercase tracking-[0.2em] text-[#7A3A1A]">Next recheck</div>
                                            <div className="font-mono">
                                                {summary.nextCheck ? `~${summary.nextCheck}s` : 'n/a'}
                                            </div>
                                        </div>
                                    </div>

                                    {sparkline && (
                                        <div className="rounded-lg border border-[#3A1A0A] bg-[#120805]/80 px-3 py-2">
                                            <div className="text-[9px] uppercase tracking-[0.2em] text-[#7A3A1A]">Last 10 min</div>
                                            <svg width={sparkline.width} height={sparkline.height} className="mt-2">
                                                {sparkline.lines.map((line, idx) => (
                                                    <polyline
                                                        key={idx}
                                                        points={line.points}
                                                        fill="none"
                                                        stroke={line.color}
                                                        strokeWidth="2"
                                                        strokeLinecap="round"
                                                    />
                                                ))}
                                            </svg>
                                            <div className="mt-1 flex items-center gap-3 text-[9px] text-[#7A3A1A]">
                                                <span className="flex items-center gap-1">
                                                    <span className="h-1.5 w-3 rounded-full bg-[#FFB800]" /> Thermal margin
                                                </span>
                                                <span className="flex items-center gap-1">
                                                    <span className="h-1.5 w-3 rounded-full bg-[#22c55e]" /> Safe shift
                                                </span>
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex flex-wrap items-center gap-2 text-[10px]">
                                        <div className="text-[9px] uppercase tracking-[0.2em] text-[#7A3A1A]">Filter</div>
                                        {(['all', 'allowed', 'clipped', 'blocked'] as const).map((mode) => (
                                            <button
                                                key={mode}
                                                type="button"
                                                onClick={() => setFilterOutcome(mode)}
                                                className={clsx(
                                                    "rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]",
                                                    filterOutcome === mode
                                                        ? "border-[#FF5A00]/60 text-[#FFE65C]"
                                                        : "border-[#3A1A0A] text-[#7A3A1A]"
                                                )}
                                            >
                                                {mode}
                                            </button>
                                        ))}
                                        <div className="ml-2 text-[9px] uppercase tracking-[0.2em] text-[#7A3A1A]">Group</div>
                                        {(['off', 'reason', 'window'] as const).map((mode) => (
                                            <button
                                                key={mode}
                                                type="button"
                                                onClick={() => setGrouping(mode)}
                                                className={clsx(
                                                    "rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]",
                                                    grouping === mode
                                                        ? "border-[#FF5A00]/60 text-[#FFE65C]"
                                                        : "border-[#3A1A0A] text-[#7A3A1A]"
                                                )}
                                            >
                                                {mode}
                                            </button>
                                        ))}
                                        <label className="ml-2 flex items-center gap-2 text-[10px] text-[#7A3A1A]">
                                            <input
                                                type="checkbox"
                                                checked={onlyStateChanges}
                                                onChange={(e) => setOnlyStateChanges(e.target.checked)}
                                                className="accent-[#FF5A00]"
                                            />
                                            Only state changes
                                        </label>
                                        <input
                                            value={searchTerm}
                                            onChange={(e) => setSearchTerm(e.target.value)}
                                            placeholder="Search..."
                                            className="ml-auto rounded-full border border-[#3A1A0A] bg-[#120805] px-3 py-1 text-[10px] text-[#FFE65C] placeholder:text-[#5A2A14]"
                                        />
                                    </div>

                                        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                                            <div className="lg:col-span-8 rounded-lg border border-[#3A1A0A] bg-[#120805]/80">
                                            <div className="grid grid-cols-8 gap-2 border-b border-[#3A1A0A] px-3 py-2 text-[9px] uppercase tracking-[0.2em] text-[#7A3A1A]">
                                                <div>Time</div>
                                                <div className="col-span-2">Requested {"->"} Applied</div>
                                                <div>Outcome</div>
                                                <div>Constraint</div>
                                                <div>Margin</div>
                                                <div>Confidence</div>
                                                <div>Action</div>
                                            </div>
                                            {decisionLog.length === 0 ? (
                                                <div className="px-3 py-4 text-xs text-slate-300">
                                                    {decisionLogError ?? 'No recent decisions yet.'}
                                                </div>
                                            ) : (
                                                <div
                                                    ref={tableScrollRef}
                                                    onScroll={(e) => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}
                                                    className="max-h-80 overflow-y-auto scrollbar-twin"
                                                >
                                                    <div
                                                        style={{
                                                            paddingTop: virtualizationEnabled ? visibleRange.start * rowHeight : 0,
                                                            paddingBottom: virtualizationEnabled
                                                                ? Math.max(0, (groupedRows.length - visibleRange.end) * rowHeight)
                                                                : 0,
                                                        }}
                                                    >
                                                    {visibleRows.map((row) => {
                                                        const entry = row.entries[0];
                                                        const outcome = row.outcome;
                                                        const statusTone = outcome === 'blocked'
                                                            ? "text-[#E10600] border-[#E10600]/50"
                                                            : outcome === 'clipped'
                                                                ? "text-[#FFB800] border-[#FFB800]/50"
                                                                : "text-[#10B981] border-[#10B981]/40";
                                                        const isSelected = selectedRowId === row.id;
                                                        const windowSeconds = Math.max(
                                                            0,
                                                            (new Date(row.last_ts).getTime() - new Date(row.first_ts).getTime()) / 1000
                                                        );
                                                        const windowLabel = row.count > 1
                                                            ? `x${row.count} in ${Math.max(1, Math.round(windowSeconds / 60))}m`
                                                            : null;
                                                        return (
                                                            <div
                                                                key={row.id}
                                                                className={clsx(
                                                                    "grid grid-cols-8 gap-2 px-3 py-2 text-xs border-b border-[#1A0B06] last:border-b-0 cursor-pointer",
                                                                    isSelected ? "bg-[#0B0705]/60" : "hover:bg-[#0B0705]/40"
                                                                )}
                                                                onClick={() => setSelectedRowId(row.id)}
                                                            >
                                                                <div className="font-mono text-[#7A3A1A]">
                                                                    {formatShortTime(row.last_ts)}
                                                                    {windowLabel && (
                                                                        <div className="text-[9px] text-[#7A3A1A]">{windowLabel}</div>
                                                                    )}
                                                                </div>
                                                                <div className="col-span-2 text-[#FFE65C]">
                                                                    {formatSignedKw(entry.requested_kw)} {"->"} {formatSignedKw(entry.approved_kw)}
                                                                </div>
                                                                <div>
                                                                    <span className={clsx("rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em]", statusTone)}>
                                                                        {formatOutcomeLabel(outcome)}
                                                                    </span>
                                                                </div>
                                                                <div className="text-[#FFB800]">
                                                                    {entry.primary_constraint ?? 'n/a'}
                                                                </div>
                                                                <div className="font-mono text-[#FFE65C]">
                                                                    {marginLabel(entry)}
                                                                </div>
                                                                <div className="font-mono text-[#7A3A1A]">
                                                                    {Number.isFinite(entry.confidence) ? `${Math.round((entry.confidence as number) * 100)}%` : '--'}
                                                                </div>
                                                                <div>
                                                                    <button
                                                                        type="button"
                                                                        className="rounded-md border border-[#3A1A0A] px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-[#FFE65C]"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            setExpandedGroups((prev) => ({
                                                                                ...prev,
                                                                                [row.id]: !prev[row.id],
                                                                            }));
                                                                        }}
                                                                    >
                                                                        {expandedGroups[row.id] ? 'Hide' : 'View'}
                                                                    </button>
                                                                </div>
                                                                {expandedGroups[row.id] && (
                                                                    <div className="col-span-8 pb-2 text-[10px] text-[#7A3A1A]">
                                                                        {row.entries.length > 1
                                                                            ? `Attempts: ${row.entries.map((e) => formatShortTime(e.ts)).join(', ')}`
                                                                            : row.count > 1
                                                                                ? `Coalesced ${row.count} attempts within ${COALESCE_WINDOW_S}s.`
                                                                                : 'Single attempt.'}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                        <div className="lg:col-span-4 rounded-lg border border-[#3A1A0A] bg-[#120805]/80 p-3">
                                            <div className="text-[9px] uppercase tracking-[0.2em] text-[#7A3A1A]">Inspector</div>
                                            {selectedRow ? (
                                                <div className="mt-2 space-y-2 text-xs text-[#FFE65C]">
                                                    <div className="font-mono">{selectedRow.entries[0].decision_id}</div>
                                                    <div>Outcome: {formatOutcomeLabel(selectedRow.outcome)}</div>
                                                    <div>Reason: {selectedRow.entries[0].reason_code}</div>
                                                    <div>Constraint: {selectedRow.entries[0].primary_constraint ?? 'n/a'}</div>
                                                    <div>Requested: {formatSignedKw(selectedRow.entries[0].requested_kw)}</div>
                                                    <div>Applied: {formatSignedKw(selectedRow.entries[0].approved_kw)}</div>
                                                    <div>Margin: {marginLabel(selectedRow.entries[0])}</div>
                                                    <div>Confidence: {Number.isFinite(selectedRow.entries[0].confidence) ? `${Math.round((selectedRow.entries[0].confidence as number) * 100)}%` : 'n/a'}</div>
                                                    <div className="pt-2 text-[10px] uppercase tracking-[0.2em] text-[#7A3A1A]">Guardrails (live)</div>
                                                    <div>Thermal margin: {latest ? `${(THERMAL_MAX_C - latest.rack_temp_c).toFixed(1)}C` : 'n/a'}</div>
                                                    <div>Grid headroom: {latest ? `${latest.safe_shift_kw.toFixed(0)} kW` : 'n/a'}</div>
                                                    <div>Freq margin: {latest ? `${(latest.frequency_hz - 59.95).toFixed(3)} Hz` : 'n/a'}</div>
                                                    <div className="pt-2 text-[10px] uppercase tracking-[0.2em] text-[#7A3A1A]">What would make this allowed?</div>
                                                    <div className="text-slate-200">
                                                        {selectedRow.entries[0].primary_constraint?.toUpperCase() === 'THERMAL'
                                                            ? 'Need additional thermal margin (cooling recovery).'
                                                            : selectedRow.entries[0].primary_constraint?.toUpperCase() === 'GRID'
                                                                ? 'Reduce line loading or increase headroom.'
                                                                : 'Relax policy constraints.'}
                                                    </div>
                                                    <div className="pt-2 text-[10px] uppercase tracking-[0.2em] text-[#7A3A1A]">Recommended alleviation</div>
                                                    <div className="text-slate-200">
                                                        {selectedRow.entries[0].primary_constraint?.toUpperCase() === 'THERMAL'
                                                            ? 'Increase cooling or defer 2-3 minutes.'
                                                            : selectedRow.entries[0].primary_constraint?.toUpperCase() === 'GRID'
                                                                ? 'Shift -200 kW from the constrained feeder.'
                                                                : 'Hold and recheck.'}
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="mt-2 text-xs text-slate-300">
                                                    Select a row to inspect details.
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </section>
                    </div>
                </div>
            </main>
        </div>
    );
}

