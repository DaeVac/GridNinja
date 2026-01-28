'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Server, Zap } from 'lucide-react';
import ReactFlow, {
  Background,
  Controls,
  Edge,
  Node,
  NodeMouseHandler,
  useEdgesState,
  useNodesState,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { clsx } from 'clsx';
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

// Allow env override, default to relative /api for proxying
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || '/api';
const CLEAN_API_BASE = API_BASE.replace(/\/+$/, '');

// --- Custom Node rendering ---
const NodeIcon = ({
  kind,
  className,
}: {
  kind: GridNodeKind;
  className?: string;
}) => {
  switch (kind) {
    case 'substation':
      return <Zap className={className} />;
    case 'dc':
      return <Server className={className} />;
    case 'pv':
      return <Activity className={className} />;
    default:
      return (
        <div className={clsx('h-2 w-2 rounded-full bg-gray-500', className)} />
      );
  }
};

const CustomNodeLabel = ({
  label,
  kind,
  isDc,
}: {
  label: string;
  kind: GridNodeKind;
  isDc: boolean;
}) => {
  return (
    <div className="flex flex-col items-center justify-center">
      <div
        className={clsx(
          'mb-1 flex h-8 w-8 items-center justify-center rounded-full border-2',
          isDc
            ? 'border-blue-500 bg-blue-100 text-blue-600'
            : kind === 'substation'
              ? 'border-amber-500 bg-amber-100 text-amber-600'
              : 'border-gray-300 bg-white text-gray-500'
        )}
      >
        <NodeIcon kind={kind} className="h-4 w-4" />
      </div>
      <div className="rounded border border-[#3A1A0A] bg-[#120805]/80 px-1.5 text-[10px] font-semibold text-[#F8F5EE]">
        {label}
      </div>
    </div>
  );
};

const FALLBACK_LEVELS = [1, 4, 8, 10, 10];
const FALLBACK_PV_BUSES = new Set([6, 12, 18, 24, 30]);
const FALLBACK_SUBSTATION_BUS = 1;
const FALLBACK_DC_BUS = 18;

const buildFallbackTopology = () => {
  const nodes: GridTopologyNode[] = [];
  const edges: GridTopologyEdge[] = [];
  let prevLevelLabels: number[] = [];

  FALLBACK_LEVELS.forEach((count, levelIdx) => {
    const levelLabels: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const label = nodes.length + 1;
      let kind: GridNodeKind = 'load';
      if (label === FALLBACK_SUBSTATION_BUS) kind = 'substation';
      if (label === FALLBACK_DC_BUS) kind = 'dc';
      if (FALLBACK_PV_BUSES.has(label)) kind = 'pv';

      const x = levelIdx * 160;
      const y = (i - (count - 1) / 2) * 80;

      nodes.push({
        id: String(label),
        label: `Bus ${label}`,
        kind,
        x,
        y,
      });
      levelLabels.push(label);
    }

    if (prevLevelLabels.length > 0) {
      levelLabels.forEach((child, idx) => {
        const parent = prevLevelLabels[idx % prevLevelLabels.length];
        edges.push({
          id: `${parent}-${child}`,
          source: String(parent),
          target: String(child),
          r_ohm: 0.05,
          x_ohm: 0.02,
        });
      });
    }
    prevLevelLabels = levelLabels;
  });

  return { nodes, edges };
};

const toReactFlowNodes = (items: GridTopologyNode[]): Node[] =>
  items.map((n) => ({
    id: n.id,
    position: { x: n.x, y: -n.y },
    data: {
      label: (
        <CustomNodeLabel
          label={n.label}
          kind={n.kind}
          isDc={n.kind === 'dc'}
        />
      ),
    },
    style: { background: 'transparent', border: 'none', width: 'auto' },
  }));

const toReactFlowEdges = (items: GridTopologyEdge[]): Edge[] =>
  items.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: 'smoothstep',
    animated: true,
    style: { stroke: '#999', strokeWidth: 1.5 },
    label: `R=${e.r_ohm.toFixed(2)}`,
    labelStyle: { fontSize: 10, fill: '#F8F5EE', fontWeight: 600 },
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 4,
    labelBgStyle: {
      fill: '#030101',
      stroke: '#130303',
      strokeWidth: 1,
      opacity: 0.9,
    },
  }));

// --- Props ---
interface GridVisualizerProps {
  telemetry: TelemetryPoint | null;
}

export default function GridVisualizer({ telemetry }: GridVisualizerProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [topologyStatus, setTopologyStatus] = useState<
    'loading' | 'ready' | 'error'
  >('loading');
  const [topologyMessage, setTopologyMessage] = useState<string | null>(null);

  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [prediction, setPrediction] = useState<PredictionResponse | null>(null);
  const [loadingPred, setLoadingPred] = useState(false);

  // Black Box Explainer state
  const [lastDecision, setLastDecision] = useState<any | null>(null);
  const [explainReport, setExplainReport] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [explainCache, setExplainCache] = useState<Record<string, string>>({});
  const [postMortemOpen, setPostMortemOpen] = useState(false);

  // Optimization: Hysteresis tracking
  const lastStressRef = useRef<boolean | null>(null);
  const predAbortRef = useRef<AbortController | null>(null);
  const rfInstanceRef = useRef<any>(null);
  const pendingFitRef = useRef(false);
  const reportRef = useRef<HTMLDivElement | null>(null);

  const requestFit = useCallback(() => {
    pendingFitRef.current = true;
    requestAnimationFrame(() => {
      const instance = rfInstanceRef.current;
      if (!instance) return;
      instance.fitView({ padding: 0.2, duration: 250 });
      pendingFitRef.current = false;
    });
  }, []);

  // Helper: Cache Key
  const decisionKey = (decision: any) => {
    if (decision?.decision_id) return String(decision.decision_id);
    return [
      decision?.blocked,
      decision?.reason,
      decision?.requested_deltaP_kw,
      decision?.approved_deltaP_kw,
      decision?.ts,
    ].join('|');
  };

  // Action: Test Injection
  const requestInjection = async (requestedKw: number) => {
    try {
      setPostMortemOpen(false);
      setExplainReport(null);
      const P_site_kw = telemetry?.total_load_kw ?? 50000;
      const grid_headroom_kw = prediction?.safe_shift_kw ?? 2000;

      const params = new URLSearchParams();
      params.set('deltaP_request_kw', String(requestedKw));
      params.set('P_site_kw', String(P_site_kw));
      params.set('grid_headroom_kw', String(grid_headroom_kw));

      const res = await fetch(
        `${CLEAN_API_BASE}/decision/latest?${params.toString()}`
      );
      if (!res.ok) return;
      const data = await res.json();
      setLastDecision(data);
    } catch (e) {
      console.error(e);
    }
  };

  // Action: Explain Blocked Decision
  const explainBlocked = async () => {
    if (!lastDecision) return;

    const key = decisionKey(lastDecision);
    if (explainCache[key]) {
      setPostMortemOpen(true);
      setExplainReport(explainCache[key]);
      return;
    }

    setExplaining(true);
    setPostMortemOpen(true);
    setExplainReport(null);

    try {
      const res = await fetch(`${CLEAN_API_BASE}/explain/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: lastDecision }),
      });

      if (!res.ok) {
        setExplainReport('Could not generate report (backend error).');
        return;
      }

      const data = await res.json();
      const report = data.report_markdown ?? 'No report returned.';

      setExplainCache((prev) => ({ ...prev, [key]: report }));
      setExplainReport(report);
    } catch (e) {
      console.error(e);
      setExplainReport('Could not generate report (network error).');
    } finally {
      setExplaining(false);
    }
  };

  // 1. Fetch Topology
  const loadTopology = useCallback(
    async (signal?: AbortSignal) => {
      setTopologyStatus('loading');
      setTopologyMessage(null);

      try {
        const res = await fetch(`${CLEAN_API_BASE}/grid/topology`, { signal });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();

        if (!data || !Array.isArray(data.nodes)) {
          throw new Error('Malformed topology payload');
        }

        const nodesData = data.nodes as GridTopologyNode[];
        const edgesData = Array.isArray(data.edges)
          ? (data.edges as GridTopologyEdge[])
          : [];

        if (nodesData.length === 0) {
          throw new Error('Empty topology payload');
        }

        setNodes(toReactFlowNodes(nodesData));
        setEdges(toReactFlowEdges(edgesData));
        setTopologyStatus('ready');
        requestFit();
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        console.error('Failed to load topology', err);

        const fallback = buildFallbackTopology();
        setNodes(toReactFlowNodes(fallback.nodes));
        setEdges(toReactFlowEdges(fallback.edges));
        setTopologyStatus('error');
        setTopologyMessage('Topology offline. Showing local demo layout.');
        requestFit();
      }
    },
    [requestFit, setNodes, setEdges]
  );

  useEffect(() => {
    const controller = new AbortController();
    loadTopology(controller.signal);
    return () => controller.abort();
  }, [loadTopology]);

  useEffect(() => {
    if (!nodes.length || !rfInstanceRef.current) return;
    requestFit();
  }, [nodes.length, requestFit]);

  useEffect(() => {
    if (!postMortemOpen) return;
    requestAnimationFrame(() => {
      reportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [postMortemOpen, explaining, explainReport]);

  // 2. Telemetry & Animation Logic (Hysteresis)
  useEffect(() => {
    if (!telemetry) return;

    const freq =
      typeof telemetry.frequency_hz === 'number'
        ? telemetry.frequency_hz
        : 60.0;

    const STRESS_ON = 59.95;
    const STRESS_OFF = 59.97;

    const prev = lastStressRef.current;
    const isStressNow =
      prev === null
        ? freq < STRESS_ON
        : prev
          ? !(freq > STRESS_OFF)
          : freq < STRESS_ON;

    if (prev === null || isStressNow !== prev) {
      lastStressRef.current = isStressNow;

      setEdges((eds) =>
        eds.map((e) => ({
          ...e,
          animated: true,
          style: {
            ...(e.style ?? {}),
            stroke: isStressNow ? '#ef4444' : '#10b981', // Red vs Emerald
            strokeWidth: isStressNow ? 3 : 2,
          },
        }))
      );
    }
  }, [telemetry, setEdges]);

  // 3. Node Click
  const onNodeClick: NodeMouseHandler = useCallback(async (_, node) => {
    setSelectedNode(node.id);
    setPrediction(null);
    setLoadingPred(true);
    setLastDecision(null);
    setExplainReport(null);
    setPostMortemOpen(false);
    setExplaining(false);

    if (predAbortRef.current) {
      predAbortRef.current.abort();
    }
    const controller = new AbortController();
    predAbortRef.current = controller;

    try {
      const res = await fetch(
        `${CLEAN_API_BASE}/grid/predict?node_id=${node.id}`,
        {
          signal: controller.signal,
        }
      );
      if (!res.ok) {
        setPrediction(null);
        return;
      }
      const data = await res.json();
      setPrediction(data);
    } catch (err: any) {
      if (err.name !== 'AbortError') console.error('Prediction failed', err);
    } finally {
      if (!controller.signal.aborted) setLoadingPred(false);
    }
  }, []);

  return (
    <div className="relative flex h-full w-full overflow-hidden">
      {/* React Flow Canvas */}
      <div className="relative h-full flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          defaultEdgeOptions={{ animated: true }}
          fitView
          onInit={(instance) => {
            rfInstanceRef.current = instance;
            if (pendingFitRef.current || nodes.length) {
              requestFit();
            }
          }}
          attributionPosition="bottom-left"
          className="h-full w-full"
        >
          <Background color="#3A1A0A" gap={20} />
          <Controls />
        </ReactFlow>

        {topologyStatus !== 'ready' && (
          <div className="absolute bottom-4 left-4 z-20 rounded-lg border border-[#3A1A0A] bg-[#120805]/90 px-4 py-3 text-xs text-[#FFE65C] shadow-lg">
            <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7A3A1A]">
              Topology
            </div>
            <div className="mt-1">
              {topologyStatus === 'loading'
                ? 'Loading topology...'
                : topologyMessage ?? 'Topology unavailable.'}
            </div>
            {topologyStatus === 'error' && (
              <button
                onClick={() => loadTopology()}
                className="mt-3 w-full rounded-md border border-[#3A1A0A] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#FFE65C] transition-colors hover:border-[#FF5A00]/60 hover:text-white"
              >
                Retry
              </button>
            )}
          </div>
        )}

        {/* Telemetry Overlay */}
        <div className="absolute right-4 top-4 z-10 rounded-lg border border-[#3A1A0A] bg-[#120805]/85 p-4 shadow-lg backdrop-blur-sm transition-colors duration-300">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#7A3A1A]">
            Live Grid Status
          </h3>
          {telemetry ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-[#7A3A1A]">Frequency</span>
                <span
                  className={clsx(
                    'font-mono font-bold transition-colors',
                    telemetry.frequency_hz < 59.95
                      ? 'animate-pulse text-[#E10600]'
                      : 'text-[#FFE65C]'
                  )}
                >
                  {telemetry.frequency_hz.toFixed(3)} Hz
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-[#7A3A1A]">Total Load</span>
                <span className="font-mono text-[#FFB800]">
                  {telemetry.total_load_kw.toFixed(0)} kW
                </span>
              </div>
            </div>
          ) : (
            <div className="animate-pulse text-xs text-[#FFB800]">
              Connecting to SCADA...
            </div>
          )}
        </div>
      </div>

      {/* Sidebar: Prediction */}
      {selectedNode && (
        <div className="scrollbar-twin z-20 flex h-full w-80 shrink-0 flex-col overflow-y-auto border-l border-[#3A1A0A] bg-[#120805] p-6 shadow-xl">
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-[#FFE65C]">
              Node {selectedNode}
            </h2>
            <button
              onClick={() => setSelectedNode(null)}
              className="text-[#7A3A1A] transition-colors hover:text-[#FFE65C]"
            >
              ✕
            </button>
          </div>

          {loadingPred ? (
            <div className="flex flex-col items-center justify-center space-y-3 py-10">
              <Activity className="h-8 w-8 animate-spin text-[#FFB800]" />
              <p className="text-sm text-[#7A3A1A]">Running GNN Inference...</p>
            </div>
          ) : prediction ? (
            <div className="animate-in slide-in-from-right-4 duration-300 space-y-6 fade-in">
              {/* Headroom Card */}
              <div className="rounded-lg border border-[#3A1A0A] bg-[#0B0705] p-4">
                <div className="mb-2 text-xs uppercase tracking-[0.2em] text-[#7A3A1A]">
                  Safe Shift Headroom
                </div>
                <div className="text-3xl font-bold text-[#FFB800]">
                  {prediction.safe_shift_kw?.toFixed(0) ?? '—'}{' '}
                  <span className="text-sm font-normal text-[#7A3A1A]">kW</span>
                </div>
                <div className="mt-2 flex items-center gap-1 text-xs text-[#FFE65C]">
                  <Zap className="h-3 w-3" />
                  Confidence: {(prediction.confidence * 100).toFixed(0)}%
                </div>
              </div>

              {/* Debug Section */}
              <div className="space-y-3">
                <h4 className="border-b border-[#3A1A0A] pb-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#FFE65C]">
                  AI Reasoning
                </h4>
                <div className="text-sm text-[#7A3A1A]">
                  Clamp Reason:{' '}
                  <span className="font-medium text-[#FFE65C]">
                    {prediction.reason_code}
                  </span>
                </div>

                {prediction.debug && (
                  <div className="space-y-2 rounded border border-[#3A1A0A] bg-[#0B0705] p-3">
                    <h5 className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#7A3A1A]">
                      Input Factors
                    </h5>
                    {Object.entries(prediction.debug).map(([k, v]) => (
                      <div key={k} className="flex justify-between text-xs">
                        <span className="font-mono text-[#7A3A1A]">{k}</span>
                        <span className="font-mono text-[#FFE65C]">
                          {typeof v === 'number' ? v.toFixed(3) : v}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="mt-6 space-y-3 border-t border-[#3A1A0A] pt-4">
                <button
                  onClick={() => requestInjection(500)}
                  className="w-full rounded-lg border border-[#FF5A00]/40 bg-[#120805] py-2 text-sm text-[#FFE65C] transition-colors hover:border-[#FF5A00]/70 hover:text-white"
                >
                  Test Injection (500 kW)
                </button>

                {lastDecision && (
                  <div className="rounded-lg border border-[#3A1A0A] bg-[#0B0705] p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7A3A1A]">
                      Controller Decision
                    </div>
                    <div className="mt-2 text-sm text-[#FFE65C]">
                      Requested:{' '}
                      <span className="font-mono">
                        {lastDecision.requested_deltaP_kw}
                      </span>{' '}
                      kW
                      <br />
                      Approved:{' '}
                      <span className="font-mono">
                        {lastDecision.approved_deltaP_kw}
                      </span>{' '}
                      kW
                      <br />
                      Status:{' '}
                      <span
                        className={
                          lastDecision.blocked
                            ? 'font-semibold text-[#E10600]'
                            : 'font-semibold text-[#FFE65C]'
                        }
                      >
                        {lastDecision.blocked ? 'BLOCKED' : 'ALLOWED/CLIPPED'}
                      </span>
                    </div>

                <button
                  onClick={explainBlocked}
                  disabled={explaining}
                  className="mt-3 w-full rounded-lg border border-[#3A1A0A] py-2 text-sm text-[#FFE65C] transition-colors hover:border-[#FF5A00]/60 disabled:opacity-60"
                >
                  {explaining
                    ? 'Generating Post-Mortem...'
                    : lastDecision.blocked
                      ? 'Why was this blocked?'
                      : 'Explain this decision'}
                </button>
                  </div>
                )}

                {lastDecision &&
                  (postMortemOpen || explaining || explainReport !== null) && (
                    <div
                      ref={reportRef}
                      className="rounded-lg border border-[#3A1A0A] bg-[#0B0705] p-4 text-sm text-[#FFE65C]"
                    >
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7A3A1A]">
                      {lastDecision?.blocked ? 'Post-Mortem Report' : 'Decision Report'}
                    </div>
                    {explaining ? (
                      <div className="animate-pulse text-xs text-[#FFB800]">
                        Generating report...
                      </div>
                    ) : (
                      <div className="whitespace-pre-wrap">
                        {explainReport ?? 'No report available.'}
                      </div>
                    )}
                    </div>
                  )}
              </div>
            </div>
          ) : (
            <div className="text-sm text-gray-400">
              Select a node to analyze.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
