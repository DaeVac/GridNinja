"use client";

import React from "react";
import clsx from "clsx";

type DemoState = "idle" | "checking" | "enabling" | "enabled" | "error";

const API_BASE = "/api";

export default function DemoModeButton({ className }: { className?: string }) {
    const [state, setState] = React.useState<DemoState>("idle");
    const [error, setError] = React.useState<string | null>(null);

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
            } catch {
                if (!alive) return;
                setState("idle");
            }
        };

        fetchStatus();
        return () => {
            alive = false;
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

    const label =
        state === "enabled"
            ? "DEMO ON"
            : state === "enabling"
                ? "ENABLING..."
                : state === "checking"
                    ? "CHECKING..."
                    : "ENABLE DEMO";

    return (
        <div className={clsx("flex items-center gap-2", className)}>
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
    );
}
