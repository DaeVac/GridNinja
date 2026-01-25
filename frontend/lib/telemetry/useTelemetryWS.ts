"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type TelemetryPoint = {
    ts: string;
    frequency_hz: number;
    rocof_hz_s: number;
    stress_score: number;
    total_load_kw: number;
    safe_shift_kw: number;
    carbon_g_per_kwh: number;
    rack_temp_c: number;
    cooling_kw: number;
};

type WSStatus = "connecting" | "open" | "error" | "closed";

export function useTelemetryWS(bufferSize = 180) {
    const WS_BASE =
        process.env.NEXT_PUBLIC_WS_BASE_URL?.replace(/\/+$/, "") ?? "ws://localhost:8000";

    const url = useMemo(() => `${WS_BASE}/ws/telemetry`, [WS_BASE]);

    const wsRef = useRef<WebSocket | null>(null);
    const aliveRef = useRef(true);
    const retryRef = useRef(0);

    const [status, setStatus] = useState<WSStatus>("connecting");
    const [latest, setLatest] = useState<TelemetryPoint | null>(null);
    const [buffer, setBuffer] = useState<TelemetryPoint[]>([]);

    useEffect(() => {
        aliveRef.current = true;

        const connect = () => {
            setStatus("connecting");

            const ws = new WebSocket(url);
            wsRef.current = ws;

            ws.onopen = () => {
                retryRef.current = 0;
                setStatus("open");
            };

            ws.onmessage = (evt) => {
                try {
                    const d = JSON.parse(evt.data) as TelemetryPoint;
                    setLatest(d);
                    setBuffer((prev) => {
                        const next = [...prev, d];
                        if (next.length > bufferSize) next.splice(0, next.length - bufferSize);
                        return next;
                    });
                } catch {
                    // ignore malformed packets
                }
            };

            ws.onerror = () => setStatus("error");

            ws.onclose = () => {
                setStatus("closed");
                if (!aliveRef.current) return;

                // reconnect with backoff: 250ms -> 3s
                const retry = retryRef.current++;
                const delay = Math.min(3000, 250 * Math.pow(2, retry));
                window.setTimeout(() => aliveRef.current && connect(), delay);
            };
        };

        connect();

        return () => {
            aliveRef.current = false;
            wsRef.current?.close();
            wsRef.current = null;
        };
    }, [url, bufferSize]);

    return { status, latest, buffer };
}
