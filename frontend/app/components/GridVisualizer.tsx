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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

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

    // Optimization: Only update edges when stress logic flips
    const lastStressRef = useRef<boolean>(false);

    // Abort controller for fetch
    const predAbortRef = useRef<AbortController | null>(null);

    // 1. Fetch Topology
    useEffect(() => {
        async function fetchTopology() {
            try {
                const res = await fetch(`${API_BASE}/grid/topology`);
                const data = await res.json();

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

        const isStressNow = telemetry.frequency_hz < 59.95;

        // Only trigger React state update if status logic changed
        if (isStressNow !== lastStressRef.current) {
            lastStressRef.current = isStressNow;

            setEdges((eds) =>
                eds.map((e) => ({
                    ...e,
                    animated: isStressNow,
                    style: {
                        ...e.style,
                        stroke: isStressNow ? '#ef4444' : '#999',
                        strokeWidth: isStressNow ? 3 : 1.5,
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
            const res = await fetch(`${API_BASE}/grid/predict?node_id=${node.id}`, {
                signal: controller.signal
            });
            const data = await res.json();
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
        <div className="flex h-[80vh] w-full border rounded-lg bg-gray-50 overflow-hidden relative">
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
                >
                    <Background color="#ccc" gap={20} />
                    <Controls />
                </ReactFlow>

                {/* Overlay: Telemetry Status (Properly Stylized) */}
                <div className="absolute top-4 right-4 bg-white/90 p-4 rounded-lg shadow-lg border backdrop-blur-sm z-10 transition-colors duration-300">
                    <h3 className="text-sm font-semibold text-gray-500 mb-2">Live Grid Status</h3>
                    {telemetry ? (
                        <div className="space-y-2 text-sm">
                            <div className="flex items-center justify-between gap-4">
                                <span className="text-gray-600">Frequency</span>
                                <span className={clsx(
                                    "font-mono font-bold transition-colors",
                                    telemetry.frequency_hz < 59.95 ? "text-red-600 animate-pulse" : "text-emerald-600"
                                )}>
                                    {telemetry.frequency_hz.toFixed(3)} Hz
                                </span>
                            </div>
                            <div className="flex items-center justify-between gap-4">
                                <span className="text-gray-600">Total Load</span>
                                <span className="font-mono text-blue-600">{telemetry.total_load_kw.toFixed(0)} kW</span>
                            </div>
                        </div>
                    ) : (
                        <div className="text-xs text-gray-400 animate-pulse">Connecting to SCADA...</div>
                    )}
                </div>
            </div>

            {/* Sidebar: GNN Prediction */}
            {selectedNode && (
                <div className="w-80 bg-white border-l p-6 flex flex-col shadow-xl z-20 overflow-y-auto">
                    <div className="flex items-center justify-between mb-6">
                        <h2 className="text-xl font-bold text-gray-800">Node {selectedNode}</h2>
                        <button
                            onClick={() => setSelectedNode(null)}
                            className="text-gray-400 hover:text-gray-600"
                        >
                            ✕
                        </button>
                    </div>

                    {loadingPred ? (
                        <div className="flex flex-col items-center justify-center py-10 space-y-3">
                            <Activity className="w-8 h-8 text-blue-500 animate-spin" />
                            <p className="text-sm text-gray-500">Running GNN Inference...</p>
                        </div>
                    ) : prediction ? (
                        <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                            {/* Headroom Card */}
                            <div className="bg-emerald-50 border border-emerald-100 rounded-lg p-4">
                                <div className="text-sm text-emerald-800 font-medium mb-1">Safe Shift Headroom</div>
                                <div className="text-3xl font-bold text-emerald-600">
                                    {prediction.safe_shift_kw.toFixed(0)} <span className="text-sm font-normal text-emerald-500">kW</span>
                                </div>
                                <div className="text-xs text-emerald-700 mt-2 flex items-center gap-1">
                                    <Zap className="w-3 h-3" />
                                    Confidence: {(prediction.confidence * 100).toFixed(0)}%
                                </div>
                            </div>

                            {/* Reason / Debug */}
                            <div className="space-y-3">
                                <h4 className="text-sm font-semibold text-gray-900 border-b pb-1">AI Reasoning</h4>
                                <div className="text-sm text-gray-600">
                                    Clamp Reason: <span className="font-medium text-gray-900">{prediction.reason_code}</span>
                                </div>

                                {/* Better Debug Rendering */}
                                {prediction.debug && (
                                    <div className="bg-gray-50 rounded border p-3 space-y-2">
                                        <h5 className="text-[10px] font-bold text-gray-500 uppercase">Input Factors</h5>
                                        {Object.entries(prediction.debug).map(([k, v]) => (
                                            <div key={k} className="flex justify-between text-xs">
                                                <span className="text-gray-600 font-mono">{k}</span>
                                                <span className="text-gray-900 font-mono">{typeof v === 'number' ? v.toFixed(3) : v}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="mt-8 p-4 bg-blue-50 rounded-lg text-xs text-blue-700">
                                <p className="font-semibold mb-1">GNN Context</p>
                                This prediction is generated by a Graph Neural Network analyzing the IEEE-33 topology and current load flows relative to Node {selectedNode}.
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
