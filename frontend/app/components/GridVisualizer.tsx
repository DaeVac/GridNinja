'use client';

import React, { useCallback, useEffect, useState, useRef } from 'react';
import ReactFlow, {
    Background,
    Controls,
    useNodesState,
    useEdgesState,
    Node,
    Edge,
    NodeMouseHandler,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Activity, Zap, Server } from 'lucide-react';
import clsx from 'clsx';
import { TelemetryPoint } from '@/lib/telemetry/useTelemetryWS';

// --- Types ---
type GridNodeKind = 'substation' | 'dc' | 'pv' | 'load';

interface GridTopologyNode {
    id: string;
    label: string;
    kind: GridNodeKind;
    x: number;
    y: number;
}

interface GridTopologyEdge {
    id: string;
    source: string;
    target: string;
    r_ohm: number;
    x_ohm: number;
}

interface PredictionResponse {
    node_id: string;
    safe_shift_kw: number;
    confidence: number;
    reason_code: string;
    debug?: Record<string, number>;
}

const API_BASE = "/api";
const CLEAN_API_BASE = API_BASE; // already clean

// --- Custom Node rendering (as a label component) ---
const NodeIcon = ({ kind, className }: { kind: GridNodeKind; className?: string }) => {
    switch (kind) {
        case 'substation': return <Zap className={className} />;
        case 'dc': return <Server className={className} />;
        case 'pv': return <Activity className={className} />;
        default: return <div className={clsx("w-2 h-2 rounded-full bg-gray-500", className)} />;
    }
};

const CustomNodeLabel = ({ label, kind, isDc }: { label: string, kind: GridNodeKind, isDc: boolean }) => {
    return (
        <div className="flex flex-col items-center justify-center">
            <div className={clsx(
                "flex items-center justify-center w-8 h-8 rounded-full mb-1 border-2",
                isDc ? "bg-blue-100 border-blue-500 text-blue-600" :
                    kind === 'substation' ? "bg-amber-100 border-amber-500 text-amber-600" :
                        "bg-white border-gray-300 text-gray-500"
            )}>
                <NodeIcon kind={kind} className="w-4 h-4" />
            </div>
            <div className="text-[9px] font-semibold text-gray-700 bg-white/80 px-1 rounded">{label}</div>
        </div>
    );
};

// --- Props ---
interface GridVisualizerProps {
    telemetry: TelemetryPoint | null;
}

export default function GridVisualizer({ telemetry }: GridVisualizerProps) {
    const [nodes, setNodes, onNodesChange] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);

    const [selectedNode, setSelectedNode] = useState<string | null>(null);
    const [prediction, setPrediction] = useState<PredictionResponse | null>(null);
    const [loadingPred, setLoadingPred] = useState(false);

    // Black Box Explainer state
    const [lastDecision, setLastDecision] = useState<any | null>(null);
    const [explainReport, setExplainReport] = useState<string | null>(null);
    const [explaining, setExplaining] = useState(false);
    const [explainCache, setExplainCache] = useState<Record<string, string>>({});

    // Optimization: Only update edges when stress logic flips
    const lastStressRef = useRef<boolean | null>(null);

    // Abort controller for fetch
    const predAbortRef = useRef<AbortController | null>(null);

    // Helper: Generate stable key for caching
    const decisionKey = (decision: any) => {
        if (decision?.decision_id) return String(decision.decision_id);
        return [
            decision?.blocked,
            decision?.reason,
            decision?.requested_deltaP_kw,
            decision?.approved_deltaP_kw,
            decision?.ts,
        ].join("|");
    };

    // Test Injection: Request 500kW and see controller response
    const requestInjection = async (requestedKw: number) => {
        try {
            setExplainReport(null);
            const P_site_kw = telemetry?.total_load_kw ?? 50000;
            const grid_headroom_kw = prediction?.safe_shift_kw ?? 2000;

            const params = new URLSearchParams();
            params.set("deltaP_request_kw", String(requestedKw));
            params.set("P_site_kw", String(P_site_kw));
            params.set("grid_headroom_kw", String(grid_headroom_kw));
            const res = await fetch(`${CLEAN_API_BASE}/decision/latest?${params.toString()}`);
            if (!res.ok) return;
            const data = await res.json();
            setLastDecision(data);
        } catch (e) {
            console.error(e);
        }
    };

    // Explain: Call LLM explainer on button click only
    const explainBlocked = async () => {
        if (!lastDecision) return;

        const key = decisionKey(lastDecision);

        // Cache hit: instant render, no Gemini call
        if (explainCache[key]) {
            setExplainReport(explainCache[key]);
            return;
        }

        setExplaining(true);
        setExplainReport(null);

        try {
            const res = await fetch(`${CLEAN_API_BASE}/explain/decision`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ decision: lastDecision }),
            });

            if (!res.ok) {
                setExplainReport("Could not generate report (backend error).");
                return;
            }

            const data = await res.json();
            const report = data.report_markdown ?? "No report returned.";

            // Save to cache
            setExplainCache(prev => ({ ...prev, [key]: report }));
            setExplainReport(report);
        } catch (e) {
            console.error(e);
            setExplainReport("Could not generate report (network error).");
        } finally {
            setExplaining(false);
        }
    };

    // 1. Fetch Topology
    useEffect(() => {
        async function fetchTopology() {
            try {
                const res = await fetch(`${CLEAN_API_BASE}/grid/topology`);
                if (!res.ok) throw new Error(`Status ${res.status}`);
                const data = await res.json();

                if (!data || !data.nodes) return; // Guard empty response

                // Transform Nodes
                const rfNodes: Node[] = data.nodes.map((n: GridTopologyNode) => ({
                    id: n.id,
                    position: { x: n.x, y: -n.y }, // Keep Y-flip if backend uses cartesian up
                    data: {
                        label: <CustomNodeLabel label={n.label} kind={n.kind} isDc={n.kind === 'dc'} />
                    },
                    // Remove default styling to let custom label handle visual weight
                    style: { background: 'transparent', border: 'none', width: 'auto' },
                }));

                // Transform Edges
                const rfEdges: Edge[] = data.edges.map((e: GridTopologyEdge) => ({
                    id: e.id,
                    source: e.source,
                    target: e.target,
                    type: 'smoothstep',
                    animated: false,
                    style: { stroke: '#999', strokeWidth: 1.5 },
                    // Optional: Add basic tooltips
                    label: `R=${e.r_ohm.toFixed(2)}`,
                    labelStyle: { fontSize: 9, fill: '#aaa' },
                }));

                setNodes(rfNodes);
                setEdges(rfEdges);
            } catch (err) {
                console.error("Failed to load topology", err);
            }
        }
        fetchTopology();
    }, [setNodes, setEdges]);

    // 2. React to Telemetry (Visual Stress)
    useEffect(() => {
        if (!telemetry) return;

        const freq = typeof telemetry.frequency_hz === 'number' ? telemetry.frequency_hz : 60.0;

        // Simple threshold (your version):
        // const isStressNow = freq < 59.95;

        // Better: hysteresis to prevent flicker around the boundary
        const STRESS_ON = 59.95;
        const STRESS_OFF = 59.97;

        const prev = lastStressRef.current;
        const isStressNow =
            prev === null
                ? freq < STRESS_ON
                : prev
                    ? !(freq > STRESS_OFF) // if stressed, stay stressed until we recover above OFF
                    : freq < STRESS_ON;    // if healthy, only enter stress below ON

        // Only trigger React state update if status logic changed
        if (prev === null || isStressNow !== prev) {
            lastStressRef.current = isStressNow;

            setEdges((eds) =>
                eds.map((e) => ({
                    ...e,
                    animated: true, // ALWAYS TRUE
                    style: {
                        ...(e.style ?? {}),
                        stroke: isStressNow ? '#ef4444' : '#10b981',
                        strokeWidth: isStressNow ? 3 : 2,
                    }
                }))
            );
        }
    }, [telemetry, setEdges]);

    // 3. Node Click -> Prediction (Cancellable)
    const onNodeClick: NodeMouseHandler = useCallback(async (_, node) => {
        setSelectedNode(node.id);
        setPrediction(null);
        setLoadingPred(true);

        // Abort previous if pending
        if (predAbortRef.current) {
            predAbortRef.current.abort();
        }
        const controller = new AbortController();
        predAbortRef.current = controller;

        try {
            const cleanBase = CLEAN_API_BASE.replace(/\/+$/, "");
            const res = await fetch(`${cleanBase}/grid/predict?node_id=${node.id}`, {
                signal: controller.signal
            });
            if (!res.ok) {
                const err = await res.json().catch(() => null);
                console.error("Prediction failed:", res.status, err);
                setPrediction(null);
                setLoadingPred(false);
                return;
            }
            const data = await res.json();
            if (
                typeof data?.safe_shift_kw !== "number" ||
                typeof data?.confidence !== "number" ||
                typeof data?.reason_code !== "string"
            ) {
                console.error("Malformed prediction response:", data);
                setPrediction(null);
                setLoadingPred(false);
                return;
            }
            setPrediction(data);
        } catch (err: any) {
            if (err.name !== 'AbortError') {
                console.error("Prediction failed", err);
            }
        } finally {
            // Only unset loading if WE are the current active request (simple check: if not aborted)
            if (!controller.signal.aborted) {
                setLoadingPred(false);
            }
        }
    }, []);

    return (
        <div className="flex h-full w-full overflow-hidden relative">
            {/* React Flow Canvas */}
            <div className="flex-1 relative">
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onNodeClick={onNodeClick}
                    fitView
                    attributionPosition="bottom-left"
                    className="h-full w-full"
                >
                    <Background color="#3A1A0A" gap={20} />
                    <Controls />
                </ReactFlow>

                {/* Overlay: Telemetry Status (Properly Stylized) */}
                <div className="absolute top-4 right-4 bg-[#120805]/85 p-4 rounded-lg shadow-lg border border-[#3A1A0A] backdrop-blur-sm z-10 transition-colors duration-300">
                    <h3 className="text-xs font-semibold text-[#7A3A1A] mb-2 uppercase tracking-[0.2em]">Live Grid Status</h3>
                    {telemetry ? (
                        <div className="space-y-2 text-sm">
                            <div className="flex items-center justify-between gap-4">
                                <span className="text-[#7A3A1A]">Frequency</span>
                                <span className={clsx(
                                    "font-mono font-bold transition-colors",
                                    telemetry.frequency_hz < 59.95 ? "text-[#E10600] animate-pulse" : "text-[#FFE65C]"
                                )}>
                                    {telemetry.frequency_hz.toFixed(3)} Hz
                                </span>
                            </div>
                            <div className="flex items-center justify-between gap-4">
                                <span className="text-[#7A3A1A]">Total Load</span>
                                <span className="font-mono text-[#FFB800]">{telemetry.total_load_kw.toFixed(0)} kW</span>
                            </div>
                        </div>
                    ) : (
                        <div className="text-xs text-[#FFB800] animate-pulse">Connecting to SCADA...</div>
                    )}
                </div>
            </div>

            {/* Sidebar: GNN Prediction */}
            {selectedNode && (
                <div className="w-80 bg-[#120805] border-l border-[#3A1A0A] p-6 flex flex-col shadow-xl z-20 overflow-y-auto scrollbar-twin">
                    <div className="flex items-center justify-between mb-6">
                        <h2 className="text-lg font-semibold text-[#FFE65C]">Node {selectedNode}</h2>
                        <button
                            onClick={() => setSelectedNode(null)}
                            className="text-[#7A3A1A] hover:text-[#FFE65C] transition-colors"
                            aria-label="Close node details"
                        >
                            X
                        </button>
                    </div>

                    {loadingPred ? (
                        <div className="flex flex-col items-center justify-center py-10 space-y-3">
                            <Activity className="w-8 h-8 text-[#FFB800] animate-spin" />
                            <p className="text-sm text-[#7A3A1A]">Running GNN Inference...</p>
                        </div>
                    ) : prediction ? (
                        <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                            {/* Headroom Card */}
                            <div className="bg-[#0B0705] border border-[#3A1A0A] rounded-lg p-4">
                                <div className="text-xs text-[#7A3A1A] uppercase tracking-[0.2em] mb-2">Safe Shift Headroom</div>
                                <div className="text-3xl font-bold text-[#FFB800]">
                                    {typeof prediction.safe_shift_kw === "number"
                                        ? prediction.safe_shift_kw.toFixed(0)
                                        : "—"}{" "}
                                    <span className="text-sm font-normal text-[#7A3A1A]">kW</span>
                                </div>
                                <div className="text-xs text-[#FFE65C] mt-2 flex items-center gap-1">
                                    <Zap className="w-3 h-3" />
                                    Confidence: {(prediction.confidence * 100).toFixed(0)}%
                                </div>
                            </div>

                            {/* Reason / Debug */}
                            <div className="space-y-3">
                                <h4 className="text-xs font-semibold text-[#FFE65C] uppercase tracking-[0.2em] border-b border-[#3A1A0A] pb-2">
                                    AI Reasoning
                                </h4>
                                <div className="text-sm text-[#7A3A1A]">
                                    Clamp Reason: <span className="font-medium text-[#FFE65C]">{prediction.reason_code}</span>
                                </div>

                                {/* Better Debug Rendering */}
                                {prediction.debug && (
                                    <div className="bg-[#0B0705] rounded border border-[#3A1A0A] p-3 space-y-2">
                                        <h5 className="text-[10px] font-bold text-[#7A3A1A] uppercase tracking-[0.2em]">Input Factors</h5>
                                        {Object.entries(prediction.debug).map(([k, v]) => (
                                            <div key={k} className="flex justify-between text-xs">
                                                <span className="text-[#7A3A1A] font-mono">{k}</span>
                                                <span className="text-[#FFE65C] font-mono">{typeof v === 'number' ? v.toFixed(3) : v}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="mt-8 p-4 bg-[#0B0705] rounded-lg text-xs text-[#7A3A1A] border border-[#3A1A0A]">
                                <p className="font-semibold mb-1 text-[#FFE65C]">GNN Context</p>
                                This prediction is generated by a Graph Neural Network analyzing the IEEE-33 topology and current load flows relative to Node {selectedNode}.
                            </div>

                            {/* Black Box Explainer Section */}
                            <div className="mt-6 pt-4 border-t border-[#3A1A0A] space-y-3">
                                <button
                                    onClick={() => requestInjection(500)}
                                    className="w-full rounded-lg border border-[#FF5A00]/40 bg-[#120805] text-[#FFE65C] text-sm py-2 hover:border-[#FF5A00]/70 hover:text-white transition-colors"
                                >
                                    Test Injection (500 kW)
                                </button>

                                {lastDecision && (
                                    <div className="rounded-lg border border-[#3A1A0A] p-3 bg-[#0B0705]">
                                        <div className="text-[10px] font-semibold text-[#7A3A1A] uppercase tracking-[0.2em]">Controller Decision</div>
                                        <div className="mt-2 text-sm text-[#FFE65C]">
                                            Requested: <span className="font-mono">{lastDecision.requested_deltaP_kw}</span> kW<br />
                                            Approved: <span className="font-mono">{lastDecision.approved_deltaP_kw}</span> kW<br />
                                            Status:{" "}
                                            <span className={lastDecision.blocked ? "text-[#E10600] font-semibold" : "text-[#FFE65C] font-semibold"}>
                                                {lastDecision.blocked ? "BLOCKED" : "ALLOWED/CLIPPED"}
                                            </span>
                                            <div className="text-xs text-[#7A3A1A] mt-1">
                                                Reason: <span className="font-mono">{lastDecision.reason}</span>
                                            </div>
                                        </div>

                                        {lastDecision.blocked && (
                                            <button
                                                onClick={explainBlocked}
                                                className="mt-3 w-full rounded-lg border border-[#3A1A0A] text-sm py-2 text-[#FFE65C] hover:border-[#FF5A00]/60 disabled:opacity-60 transition-colors"
                                                disabled={explaining}
                                            >
                                                {explaining ? "Generating Post-Mortem..." : "Why was this blocked?"}
                                            </button>
                                        )}
                                    </div>
                                )}

                                {explainReport && (
                                    <div className="rounded-lg border border-[#3A1A0A] p-4 bg-[#0B0705]">
                                        <div className="text-[10px] font-semibold text-[#7A3A1A] uppercase tracking-[0.2em] mb-2">
                                            Post-Mortem Report
                                        </div>
                                        <div className="whitespace-pre-wrap text-sm text-[#FFE65C] leading-relaxed">
                                            {explainReport}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="text-gray-400 text-sm">Select a node to analyze.</div>
                    )}
                </div>
            )}
        </div>
    );
}

