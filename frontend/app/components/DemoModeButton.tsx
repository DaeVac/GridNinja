"use client";

import React from "react";
import clsx from "clsx";

type DemoState = "idle" | "checking" | "enabling" | "enabled" | "error";

const API_BASE = "/api";

export default function DemoModeButton({ className }: { className?: string }) {
    const [state, setState] = React.useState<DemoState>("idle");
    const [error, setError] = React.useState<string | null>(null);
    const [scenarioId, setScenarioId] = React.useState<string | null>(null);
    const [scenarioTime, setScenarioTime] = React.useState<number | null>(null);

    React.useEffect(() => {
        let alive = true;
        const fetchStatus = async () => {
            setState("checking");
            try {
                const res = await fetch(`${API_BASE}/demo/status`, { cache: "no-store" });
                if (!res.ok) throw new Error("Demo status unavailable");
                const data = await res.json();
                if (!alive) return;
                setState(data?.demo_mode ? "enabled" : "idle");
                const scenario = data?.scenario;
                if (scenario?.active) {
                    setScenarioId(scenario.scenario_id ?? null);
                    setScenarioTime(typeof scenario.t_sim_s === "number" ? scenario.t_sim_s : null);
                } else {
                    setScenarioId(null);
                    setScenarioTime(null);
                }
            } catch {
                if (!alive) return;
                setState("idle");
            }
        };

        fetchStatus();
        const interval = window.setInterval(fetchStatus, 5000);
        return () => {
            alive = false;
            window.clearInterval(interval);
        };
    }, []);

    const enableDemo = async () => {
        if (state === "enabling" || state === "enabled" || state === "checking") return;
        setState("enabling");
        setError(null);
        try {
            const res = await fetch(`${API_BASE}/demo/enable`, { method: "POST" });
            if (!res.ok) throw new Error(`Demo enable failed (${res.status})`);
            setState("enabled");
        } catch (err) {
            setState("error");
            setError(err instanceof Error ? err.message : "Demo enable failed");
        }
    };

    const startScenario = async (id: string) => {
        if (state !== "enabled") return;
        const params = new URLSearchParams();
        params.set("scenario_id", id);
        params.set("speed", "5");
        try {
            await fetch(`${API_BASE}/demo/start?${params.toString()}`, { method: "POST" });
            setScenarioId(id);
            setScenarioTime(0);
        } catch {
            // ignore
        }
    };

    const stopScenario = async () => {
        if (state !== "enabled") return;
        try {
            await fetch(`${API_BASE}/demo/stop`, { method: "POST" });
        } finally {
            setScenarioId(null);
            setScenarioTime(null);
        }
    };

    const label =
        state === "enabled"
            ? "DEMO ON"
            : state === "enabling"
                ? "ENABLING..."
                : state === "checking"
                    ? "CHECKING..."
                    : "ENABLE DEMO";

    return (
        <div className={clsx("flex flex-col items-start gap-2", className)}>
            <div className="flex items-center gap-2">
            <button
                type="button"
                onClick={enableDemo}
                disabled={state === "enabling" || state === "enabled" || state === "checking"}
                className={clsx(
                    "text-[10px] font-semibold uppercase tracking-[0.2em] px-3 py-1.5 rounded-full border transition",
                    state === "enabled"
                        ? "bg-[#FFD400]/20 text-[#FFE65C] border-[#FFD400]/40"
                        : "bg-[#120805] text-[#FFE65C] border-[#E10600]/30 hover:border-[#E10600]/60",
                    state === "enabling" ? "opacity-80 cursor-wait" : "cursor-pointer"
                )}
                title={error ?? "Enable deterministic demo mode"}
            >
                {label}
            </button>
            {state === "error" && (
                <span className="text-[10px] text-[#E10600] font-semibold">FAILED</span>
            )}
            </div>
            {state === "enabled" && (
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        onClick={() => startScenario("heat_wave")}
                        className={clsx(
                            "text-[10px] font-semibold uppercase tracking-[0.2em] px-3 py-1.5 rounded-full border transition",
                            scenarioId === "heat_wave"
                                ? "bg-[#FF5A00]/20 text-[#FFE65C] border-[#FF5A00]/60"
                                : "bg-[#120805] text-[#FFE65C] border-[#3A1A0A] hover:border-[#FF5A00]/60"
                        )}
                    >
                        Heat Wave
                    </button>
                    <button
                        type="button"
                        onClick={() => startScenario("price_spike")}
                        className={clsx(
                            "text-[10px] font-semibold uppercase tracking-[0.2em] px-3 py-1.5 rounded-full border transition",
                            scenarioId === "price_spike"
                                ? "bg-[#FFB800]/20 text-[#FFE65C] border-[#FFB800]/60"
                                : "bg-[#120805] text-[#FFE65C] border-[#3A1A0A] hover:border-[#FFB800]/60"
                        )}
                    >
                        Price Spike
                    </button>
                    <button
                        type="button"
                        onClick={stopScenario}
                        disabled={!scenarioId}
                        className={clsx(
                            "text-[10px] font-semibold uppercase tracking-[0.2em] px-3 py-1.5 rounded-full border transition",
                            scenarioId
                                ? "bg-[#120805] text-[#E10600] border-[#E10600]/50 hover:border-[#E10600]/80"
                                : "bg-[#120805] text-[#7A3A1A] border-[#3A1A0A]"
                        )}
                    >
                        Stop
                    </button>
                    {scenarioId && (
                        <span className="text-[10px] font-mono text-[#7A3A1A]">
                            {scenarioId} t+{scenarioTime?.toFixed(0) ?? "0"}s
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}
