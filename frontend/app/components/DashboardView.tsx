'use client';

import React from 'react';
import { useTelemetryWS } from '@/lib/telemetry/useTelemetryWS';
import clsx from 'clsx';
import { Activity, Thermometer, Zap, RefreshCw } from 'lucide-react';
import LogoutButton from '../../components/LogoutButton';
import dynamic from 'next/dynamic';

const GridVisualizer = dynamic(() => import('./GridVisualizer'), {
    ssr: false,
    loading: () => <div className="h-full w-full flex items-center justify-center bg-gray-50 text-gray-400 text-xs">Loading Grid...</div>
});
const ThermalVisualizer3D = dynamic(() => import('./ThermalVisualizer3D'), {
    ssr: false,
    loading: () => <div className="h-full w-full flex items-center justify-center bg-slate-900 text-slate-500 text-xs">Loading 3D Engine...</div>
});

export default function DashboardView({ user }: { user: any }) {
    const { status, latest } = useTelemetryWS();

    return (
        <div className="flex flex-col min-h-screen bg-gray-50 text-gray-900 font-sans">
            {/* --- Header --- */}
            <header className="bg-white border-b px-6 py-4 flex items-center justify-between sticky top-0 z-30 shadow-sm">
                <div className="flex items-center gap-4">
                    <img src="/teamName.svg" alt="GridNinja" className="h-8" />
                    <div className="h-6 w-px bg-gray-200" />
                    <h1 className="text-lg font-semibold text-gray-700">Mission Control</h1>
                </div>

                <div className="flex items-center gap-6">
                    {/* Live Telemetry Pill */}
                    <div className="flex items-center gap-3 bg-gray-100 px-3 py-1.5 rounded-full border border-gray-200">
                        <div className="flex items-center gap-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
                            <Activity className="w-3.5 h-3.5" />
                            System Status
                        </div>
                        <div className={clsx(
                            "flex items-center gap-1.5 text-sm font-bold px-2 py-0.5 rounded-md",
                            status === 'open' ? "bg-emerald-100 text-emerald-700" :
                                status === 'connecting' ? "bg-amber-100 text-amber-700" :
                                    "bg-red-100 text-red-700"
                        )}>
                            <div className={clsx("w-2 h-2 rounded-full", status === 'open' ? "bg-emerald-500 animate-pulse" : "bg-current")} />
                            {status === 'open' ? 'ONLINE' : status.toUpperCase()}
                        </div>
                    </div>

                    {/* Quick Stats */}
                    {latest && (
                        <div className="hidden md:flex items-center gap-6 text-sm">
                            <div className="flex flex-col items-end leading-tight">
                                <span className="text-xs text-gray-400 font-medium">Frequency</span>
                                <span className={clsx("font-mono font-bold", latest.frequency_hz < 59.95 ? "text-red-600" : "text-gray-700")}>
                                    {latest.frequency_hz.toFixed(3)} Hz
                                </span>
                            </div>
                            <div className="flex flex-col items-end leading-tight">
                                <span className="text-xs text-gray-400 font-medium">Total Load</span>
                                <span className="font-mono font-bold text-gray-700">{latest.total_load_kw.toFixed(0)} kW</span>
                            </div>
                        </div>
                    )}

                    <div className="h-6 w-px bg-gray-200" />

                    <div className="flex items-center gap-3">
                        <div className="text-right hidden sm:block">
                            <div className="text-sm font-semibold text-gray-800">{user.name}</div>
                            <div className="text-xs text-gray-400">Operator</div>
                        </div>
                        <img src={user.picture} alt="Profile" className="w-9 h-9 rounded-full border border-gray-200" />
                        <LogoutButton />
                    </div>
                </div>
            </header>

            {/* --- Main Content --- */}
            <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-2 gap-6 relative overflow-hidden">

                {/* Left: Network Topology */}
                <div className="flex flex-col gap-4 min-h-[500px] lg:h-full">
                    <div className="flex items-center justify-between">
                        <h2 className="text-xl font-bold flex items-center gap-2">
                            <Zap className="w-5 h-5 text-amber-500" />
                            Grid Topology
                        </h2>
                        <span className="text-xs font-mono text-gray-400">IEEE-33 BUS SYSTEM</span>
                    </div>
                    <div className="flex-1 bg-white rounded-xl border shadow-sm relative overflow-hidden hover:shadow-md transition-shadow">
                        <GridVisualizer telemetry={latest} />
                    </div>
                </div>

                {/* Right: Thermal Twin */}
                <div className="flex flex-col gap-4 min-h-[500px] lg:h-full">
                    <div className="flex items-center justify-between">
                        <h2 className="text-xl font-bold flex items-center gap-2">
                            <Thermometer className="w-5 h-5 text-blue-500" />
                            3D Thermal Twin
                        </h2>
                        <span className="text-xs font-mono text-gray-400">PHYSICS ENGINE V2</span>
                    </div>
                    {/* Dark Card for 3D View */}
                    <div className="flex-1 bg-slate-900 rounded-xl border border-slate-700 shadow-sm relative overflow-hidden hover:shadow-md transition-shadow">
                        <ThermalVisualizer3D telemetry={latest} />
                    </div>
                </div>

            </main>
        </div>
    );
}
