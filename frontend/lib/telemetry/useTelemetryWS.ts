"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type TelemetryPoint = {
    ts: string;
    frequency_hz: number;
    rocof_hz_s: number;
    stress_score: number;
    it_load_kw?: number;
    total_load_kw: number;
    safe_shift_kw: number;
    carbon_g_per_kwh: number;
    rack_temp_c: number;
    cooling_kw: number;
    q_passive_kw?: number;
    q_active_kw?: number;
    cooling_target_kw?: number;
    cooling_cop?: number;
    price_usd_per_mwh?: number;
    scenario_id?: string | null;
    t_sim_s?: number | null;
};

type WSStatus = "connecting" | "open" | "error" | "closed";
type TelemetryTransport = "ws" | "sse" | "poll";

export function useTelemetryWS(bufferSize = 180) {
    const WS_BASE =
        process.env.NEXT_PUBLIC_WS_BASE_URL?.replace(/\/+$/, "") ?? "ws://localhost:8000";
    const API_BASE = "/api";

    const wsUrl = useMemo(() => `${WS_BASE}/ws/telemetry`, [WS_BASE]);
    const sseUrl = useMemo(() => `${API_BASE}/telemetry/stream`, []);
    const pollUrl = useMemo(() => `${API_BASE}/telemetry/latest`, []);

    const wsRef = useRef<WebSocket | null>(null);
    const esRef = useRef<EventSource | null>(null);
    const pollRef = useRef<number | null>(null);
    const aliveRef = useRef(true);
    const retryRef = useRef(0);
    const wsFailuresRef = useRef(0);
    const transportRef = useRef<TelemetryTransport>("ws");

    const [status, setStatus] = useState<WSStatus>("connecting");
    const [transport, setTransport] = useState<TelemetryTransport>("ws");
    const [latest, setLatest] = useState<TelemetryPoint | null>(null);
    const [buffer, setBuffer] = useState<TelemetryPoint[]>([]);

    useEffect(() => {
        aliveRef.current = true;

        const setTransportSafe = (next: TelemetryTransport) => {
            transportRef.current = next;
            setTransport(next);
        };

        const pushPoint = (d: TelemetryPoint) => {
            setLatest(d);
            setBuffer((prev) => {
                const next = [...prev, d];
                if (next.length > bufferSize) next.splice(0, next.length - bufferSize);
                return next;
            });
        };

        const stopPolling = () => {
            if (pollRef.current !== null) {
                window.clearInterval(pollRef.current);
                pollRef.current = null;
            }
        };

        const closeWS = () => {
            wsRef.current?.close();
            wsRef.current = null;
        };

        const closeSSE = () => {
            esRef.current?.close();
            esRef.current = null;
        };

        const startPolling = () => {
            if (!aliveRef.current) return;
            setTransportSafe("poll");
            closeWS();
            closeSSE();
            stopPolling();
            setStatus("connecting");

            let failures = 0;
            const pollOnce = async () => {
                try {
                    const res = await fetch(pollUrl, { cache: "no-store" });
                    if (!res.ok) throw new Error("poll failed");
                    const data = (await res.json()) as TelemetryPoint;
                    pushPoint(data);
                    if (aliveRef.current) setStatus("open");
                    failures = 0;
                } catch {
                    failures += 1;
                    if (failures >= 3) setStatus("error");
                }
            };

            pollOnce();
            pollRef.current = window.setInterval(pollOnce, 1000);
        };

        const startSSE = () => {
            if (!aliveRef.current) return;
            setTransportSafe("sse");
            closeWS();
            stopPolling();
            if (typeof EventSource === "undefined") {
                startPolling();
                return;
            }
            if (esRef.current) {
                closeSSE();
            }
            setStatus("connecting");

            const es = new EventSource(sseUrl);
            esRef.current = es;

            es.onopen = () => setStatus("open");
            es.onmessage = (evt) => {
                try {
                    const d = JSON.parse(evt.data) as TelemetryPoint;
                    pushPoint(d);
                } catch {
                    // ignore malformed packets
                }
            };
            es.onerror = () => {
                setStatus("error");
                if (!aliveRef.current) return;
                closeSSE();
                startPolling();
            };
        };

        const connectWS = () => {
            if (!aliveRef.current) return;
            setTransportSafe("ws");
            setStatus("connecting");

            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;
            let opened = false;

            ws.onopen = () => {
                opened = true;
                retryRef.current = 0;
                wsFailuresRef.current = 0;
                setStatus("open");
            };

            ws.onmessage = (evt) => {
                try {
                    const d = JSON.parse(evt.data) as TelemetryPoint;
                    pushPoint(d);
                } catch {
                    // ignore malformed packets
                }
            };

            ws.onerror = () => setStatus("error");

            ws.onclose = () => {
                if (!aliveRef.current) return;
                if (transportRef.current !== "ws") return;

                if (!opened) {
                    wsFailuresRef.current += 1;
                    if (wsFailuresRef.current >= 2) {
                        startSSE();
                        return;
                    }
                }

                setStatus("closed");

                // reconnect with backoff: 250ms -> 3s
                const retry = retryRef.current++;
                const delay = Math.min(3000, 250 * Math.pow(2, retry));
                window.setTimeout(() => aliveRef.current && connectWS(), delay);
            };
        };

        connectWS();

        return () => {
            aliveRef.current = false;
            closeWS();
            closeSSE();
            stopPolling();
        };
    }, [wsUrl, sseUrl, pollUrl, bufferSize]);

    return { status, transport, latest, buffer };
}
