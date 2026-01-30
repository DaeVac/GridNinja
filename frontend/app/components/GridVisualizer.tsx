'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  v_pu?: number;
  criticality?: number;
}

interface GridTopologyEdge {
  id: string;
  source: string;
  target: string;
  r_ohm: number;
  x_ohm: number;
  p_mw?: number;
  loading_pct?: number;
  rating_mva?: number;
  thermal_limit_mw?: number;
  margin_pct?: number;
  alleviation?: string;
}

interface PredictionResponse {
  node_id: string;
  safe_shift_kw: number;
  confidence: number;
  reason_code: string;
  debug?: Record<string, number>;
}

type OverlayMode = 'flow' | 'loading' | 'voltage';

type NodeData = {
  label: React.ReactNode;
  labelText?: string;
  kind?: GridNodeKind;
  v_pu?: number;
  criticality?: number;
};

type EdgeData = {
  branchId: string;
  p_mw?: number;
  loading_pct?: number;
  rating_mva?: number;
  thermal_limit_mw?: number;
  margin_pct?: number;
  alleviation?: string;
};

type HoverState =
  | { kind: 'edge'; x: number; y: number; data: EdgeData }
  | { kind: 'node'; x: number; y: number; data: NodeData & { id: string } }
  | null;

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
  voltageText,
  showVoltage,
  voltageTone,
}: {
  label: string;
  kind: GridNodeKind;
  isDc: boolean;
  voltageText?: string;
  showVoltage?: boolean;
  voltageTone?: 'safe' | 'near' | 'viol' | 'unknown';
}) => {
  const voltageClass =
    voltageTone === 'viol'
      ? 'text-[#E10600]'
      : voltageTone === 'near'
        ? 'text-[#FFB800]'
        : 'text-[#22c55e]';
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
      {showVoltage && voltageText && (
        <div className={clsx('mt-1 rounded bg-[#120805]/80 px-1 text-[9px] font-mono', voltageClass)}>
          {voltageText}
        </div>
      )}
    </div>
  );
};

const FALLBACK_LEVELS = [1, 4, 8, 10, 10];
const FALLBACK_PV_BUSES = new Set([6, 12, 18, 24, 30]);
const FALLBACK_SUBSTATION_BUS = 1;
const FALLBACK_DC_BUS = 18;

const LOADING_NEAR = 90;
const LOADING_VIOL = 100;
const V_MIN = 0.95;
const V_MAX = 1.05;
const V_NEAR_BAND = 0.01;

function edgeSeverity(loadingPct: number) {
  if (!Number.isFinite(loadingPct)) return 'unknown';
  if (loadingPct >= LOADING_VIOL) return 'viol';
  if (loadingPct >= LOADING_NEAR) return 'near';
  return 'safe';
}

function edgeStroke(sev: string) {
  if (sev === 'viol') return '#E10600';
  if (sev === 'near') return '#FFB800';
  if (sev === 'safe') return '#22c55e';
  return '#7A3A1A';
}

function edgeWidth(loadingPct: number) {
  if (!Number.isFinite(loadingPct)) return 2;
  const w = 2 + (Math.max(0, loadingPct - 50) / 50) * 4;
  return Math.min(7, Math.max(2, w));
}

function voltageState(vpu: number) {
  if (!Number.isFinite(vpu)) return 'unknown';
  if (vpu < V_MIN || vpu > V_MAX) return 'viol';
  if (vpu < V_MIN + V_NEAR_BAND || vpu > V_MAX - V_NEAR_BAND) return 'near';
  return 'safe';
}

function nodeHalo(vpu: number) {
  const s = voltageState(vpu);
  if (s === 'viol') return '0 0 0 3px rgba(225,6,0,0.55)';
  if (s === 'near') return '0 0 0 3px rgba(255,184,0,0.45)';
  if (s === 'safe') return '0 0 0 2px rgba(34,197,94,0.25)';
  return 'none';
}

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

const toReactFlowNodes = (items: GridTopologyNode[]): Node<NodeData>[] => {
  if (!items.length) return [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  const rawPositions = items.map((n) => {
    const x = n.x;
    const y = -n.y;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    return { id: n.id, x, y };
  });
  const padding = 32;
  const posMap = new Map(rawPositions.map((p) => [p.id, p]));

  return items.map((n) => {
    const raw = posMap.get(n.id);
    const x = raw ? raw.x - minX + padding : 0;
    const y = raw ? raw.y - minY + padding : 0;
    return {
      id: n.id,
      position: { x, y },
      data: {
        label: (
          <CustomNodeLabel
            label={n.label}
            kind={n.kind}
            isDc={n.kind === 'dc'}
          />
        ),
        labelText: n.label,
        kind: n.kind,
        v_pu: n.v_pu,
        criticality: n.criticality,
      },
      style: { background: 'transparent', border: 'none', width: 'auto' },
    };
  });
};

const toReactFlowEdges = (items: GridTopologyEdge[]): Edge<EdgeData>[] =>
  items.map((e) => {
    const loading = Number.isFinite(e.loading_pct) ? (e.loading_pct as number) : NaN;
    const margin =
      Number.isFinite(loading) && loading >= 0 ? Math.max(0, 100 - loading) : e.margin_pct;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'smoothstep',
      animated: true,
      style: { stroke: '#3A1A0A', strokeWidth: 2 },
      data: {
        branchId: e.id,
        p_mw: e.p_mw,
        loading_pct: e.loading_pct,
        rating_mva: e.rating_mva,
        thermal_limit_mw: e.thermal_limit_mw,
        margin_pct: margin,
        alleviation: e.alleviation,
      },
    };
  });

// --- Props ---
interface GridVisualizerProps {
  telemetry: TelemetryPoint | null;
}

export default function GridVisualizer({ telemetry }: GridVisualizerProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<NodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<EdgeData>([]);
  const [topologyStatus, setTopologyStatus] = useState<
    'loading' | 'ready' | 'error'
  >('loading');
  const [topologyMessage, setTopologyMessage] = useState<string | null>(null);

  const [overlay, setOverlay] = useState<OverlayMode>('loading');
  const [hover, setHover] = useState<HoverState>(null);

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
      instance.fitView({ padding: 0.08, duration: 350 });
      pendingFitRef.current = false;
    });
  }, []);

  const styledNodes = useMemo(() => {
    return nodes.map((n) => {
      const data = (n.data ?? {}) as NodeData;
      const vpu = data.v_pu ?? NaN;
      const showVoltage = overlay === 'voltage';
      const vState = voltageState(vpu);
      const showVoltageText = showVoltage && vState !== 'safe';
      const voltageText =
        showVoltageText && Number.isFinite(vpu) ? vpu.toFixed(3) : undefined;
      return {
        ...n,
        data: {
          ...data,
          label: (
            <CustomNodeLabel
              label={data.labelText ?? n.id}
              kind={data.kind ?? 'load'}
              isDc={data.kind === 'dc'}
              voltageText={voltageText}
              showVoltage={showVoltageText}
              voltageTone={vState}
            />
          ),
        },
        style: {
          ...(n.style ?? {}),
          boxShadow: showVoltage ? nodeHalo(vpu) : 'none',
          borderColor: '#3A1A0A',
          animationDuration: showVoltage && vState === 'viol' ? '2.8s' : undefined,
        },
        className: showVoltage && vState === 'viol' ? 'animate-pulse' : n.className,
      };
    });
  }, [nodes, overlay]);

  const styledEdges = useMemo(() => {
    return edges.map((e) => {
      const data = (e.data ?? {}) as EdgeData;
      const loading = data.loading_pct ?? NaN;
      const sev = edgeSeverity(loading);
      const showLoading = overlay === 'loading';
      const showFlow = overlay === 'flow';
      const baseStroke =
        typeof e.style?.stroke === 'string' ? (e.style.stroke as string) : '#3A1A0A';
      const baseWidth =
        typeof e.style?.strokeWidth === 'number' ? e.style.strokeWidth : 2;

      return {
        ...e,
        style: {
          ...(e.style ?? {}),
          stroke:
            showLoading && Number.isFinite(loading)
              ? edgeStroke(sev)
              : showLoading
                ? baseStroke
                : baseStroke,
          strokeWidth:
            showLoading && Number.isFinite(loading)
              ? edgeWidth(loading)
              : showLoading
                ? baseWidth
                : baseWidth,
          opacity: showLoading ? 1 : 0.9,
        },
        label:
          showFlow && Number.isFinite(data.p_mw)
            ? `${(data.p_mw as number).toFixed(1)} MW`
            : undefined,
        labelStyle: showFlow
          ? { fill: '#FFE65C', fontSize: 10, fontFamily: 'ui-monospace' }
          : undefined,
        labelBgStyle: showFlow ? { fill: 'rgba(18,8,5,0.85)' } : undefined,
        labelBgPadding: showFlow ? [6, 3] : undefined,
        labelBgBorderRadius: showFlow ? 6 : undefined,
      };
    });
  }, [edges, overlay]);

  const onEdgeMouseMove = useCallback((evt: React.MouseEvent, edge: Edge) => {
    setHover({
      kind: 'edge',
      x: evt.clientX,
      y: evt.clientY,
      data: (edge.data ?? { branchId: edge.id }) as EdgeData,
    });
  }, []);

  const onNodeMouseMove = useCallback((evt: React.MouseEvent, node: Node) => {
    const data = (node.data ?? {}) as NodeData;
    setHover({
      kind: 'node',
      x: evt.clientX,
      y: evt.clientY,
      data: {
        id: node.id,
        label: data.label,
        labelText: data.labelText,
        v_pu: data.v_pu,
        criticality: data.criticality,
      },
    });
  }, []);

  const clearHover = useCallback(() => setHover(null), []);

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

  const Chip = ({ id, label }: { id: OverlayMode; label: string }) => {
    const active = overlay === id;
    return (
      <button
        type="button"
        onClick={() => setOverlay(id)}
        className={clsx(
          'rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] border transition',
          active
            ? 'bg-[#120805] text-[#FFE65C] border-[#E10600]/60 shadow-[0_0_12px_rgba(225,6,0,0.25)]'
            : 'bg-[#0B0705] text-[#7A3A1A] border-[#3A1A0A] hover:border-[#E10600]/40 hover:text-[#FFE65C]'
        )}
      >
        {label}
      </button>
    );
  };

  const renderLegend = () => {
    if (overlay === 'flow') {
      return (
        <div className="mt-2 text-[10px] text-[#FFE65C]">
          Flow labels: positive = source -&gt; target
        </div>
      );
    }

    const items =
      overlay === 'loading'
        ? [
            { label: 'Safe', color: '#22c55e' },
            { label: 'Near', color: '#FFB800' },
            { label: 'Violating', color: '#E10600' },
          ]
        : [
            { label: 'Within band', color: '#22c55e' },
            { label: 'Near band', color: '#FFB800' },
            { label: 'Violating', color: '#E10600' },
          ];

    return (
      <div className="mt-2 flex flex-col gap-1 text-[10px] text-[#FFE65C]">
        <div className="flex flex-wrap items-center gap-3">
          {items.map((item) => (
            <div key={item.label} className="flex items-center gap-2">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: item.color }}
              />
              <span className="uppercase tracking-[0.2em] text-[#7A3A1A]">
                {item.label}
              </span>
            </div>
          ))}
        </div>
        {overlay === 'loading' ? (
          <div className="text-[9px] uppercase tracking-[0.2em] text-[#7A3A1A]">
            Near {"\u2265"} 90% · Violation {"\u2265"} 100%
          </div>
        ) : (
          <div className="text-[9px] uppercase tracking-[0.2em] text-[#7A3A1A]">
            Within 0.95-1.05 p.u. · Near 0.95-0.96 / 1.04-1.05
          </div>
        )}
      </div>
    );
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
  }, [nodes.length, edges.length, requestFit]);

  useEffect(() => {
    if (!rfInstanceRef.current) return;
    const el = document.getElementById('gridviz');
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => requestFit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [requestFit]);

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
        <div className="absolute left-3 top-3 z-20 flex flex-wrap gap-2 rounded-full border border-[#3A1A0A] bg-[#120805]/70 backdrop-blur px-2 py-1">
          <Chip id="flow" label="Power Flow (MW)" />
          <Chip id="loading" label="Congestion (%)" />
          <Chip id="voltage" label="Voltage (p.u.)" />
        </div>

        <div className="absolute left-3 bottom-3 z-20 rounded-lg border border-[#3A1A0A] bg-[#120805]/90 px-3 py-2 shadow-lg">
          <div className="text-[9px] font-semibold uppercase tracking-[0.2em] text-[#7A3A1A]">
            Legend
          </div>
          {renderLegend()}
        </div>

        <ReactFlow
          nodes={styledNodes}
          edges={styledEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onEdgeMouseMove={onEdgeMouseMove}
          onNodeMouseMove={onNodeMouseMove}
          onEdgeMouseLeave={clearHover}
          onNodeMouseLeave={clearHover}
          onPaneMouseLeave={clearHover}
          defaultEdgeOptions={{ animated: true }}
          fitView
          onInit={(instance) => {
            rfInstanceRef.current = instance;
            if (pendingFitRef.current || nodes.length) {
              requestFit();
            }
          }}
          minZoom={0.05}
          maxZoom={2.5}
          fitViewOptions={{ padding: 0.08 }}
          attributionPosition="bottom-left"
          className="h-full w-full"
        >
          <Background color="#3A1A0A" gap={20} />
          <Controls />
        </ReactFlow>

        {overlay === 'voltage' && (
          <div className="absolute right-4 top-4 z-20 flex flex-col gap-2">
            <div className="rounded-lg border border-[#3A1A0A] bg-[#120805]/90 px-3 py-2 text-[10px] text-[#FFE65C] shadow-lg">
              {(() => {
                const values = nodes
                  .map((n) => ({
                    id: n.id,
                    label: (n.data as NodeData | undefined)?.labelText ?? n.id,
                    v: (n.data as NodeData | undefined)?.v_pu,
                  }))
                  .filter((n) => Number.isFinite(n.v)) as { id: string; label: string; v: number }[];
                if (!values.length) return <div className="text-[#7A3A1A]">Voltage stats unavailable</div>;
                let vmin = values[0];
                let vmax = values[0];
                for (const v of values) {
                  if (v.v < vmin.v) vmin = v;
                  if (v.v > vmax.v) vmax = v;
                }
                return (
                  <>
                    <div className="text-[9px] uppercase tracking-[0.2em] text-[#7A3A1A]">Voltage extrema</div>
                    <div className="mt-1 flex flex-col gap-1 font-mono">
                      <div>Vmin {vmin.v.toFixed(3)} @ {vmin.label}</div>
                      <div>Vmax {vmax.v.toFixed(3)} @ {vmax.label}</div>
                    </div>
                  </>
                );
              })()}
            </div>
            {(() => {
              const violCount = nodes.filter((n) => {
                const v = (n.data as NodeData | undefined)?.v_pu;
                return Number.isFinite(v) && voltageState(v as number) === 'viol';
              }).length;
              if (!violCount) return null;
              return (
                <div className="rounded-lg border border-[#3A1A0A] bg-[#120805]/90 px-3 py-2 text-[10px] text-[#FFE65C] shadow-lg">
                  <div className="text-[9px] uppercase tracking-[0.2em] text-[#7A3A1A]">Violation cluster</div>
                  <div className="mt-1 font-mono">{violCount} buses violating</div>
                  <div className="mt-1 text-[#7A3A1A]">Likely cause: voltage sag / reactive deficit</div>
                </div>
              );
            })()}
          </div>
        )}

        {hover && (
          <div
            className="fixed z-50 pointer-events-none"
            style={{ left: hover.x + 12, top: hover.y + 12 }}
          >
            <div className="w-64 rounded-lg border border-[#3A1A0A] bg-[#120805]/95 p-3 shadow-xl">
              {hover.kind === 'edge' ? (
                <>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-[#7A3A1A] font-semibold">
                    Branch
                  </div>
                  <div className="mt-1 text-sm font-semibold text-[#FFE65C]">
                    {hover.data.branchId}
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div className="text-[#7A3A1A]">Loading</div>
                    <div className="text-slate-100 font-mono">
                      {Number.isFinite(hover.data.loading_pct)
                        ? `${hover.data.loading_pct!.toFixed(1)}%`
                        : '--'}
                    </div>

                    <div className="text-[#7A3A1A]">Flow</div>
                    <div className="text-slate-100 font-mono">
                      {Number.isFinite(hover.data.p_mw)
                        ? `${hover.data.p_mw!.toFixed(2)} MW`
                        : '--'}
                    </div>

                    <div className="text-[#7A3A1A]">Margin</div>
                    <div className="text-slate-100 font-mono">
                      {Number.isFinite(hover.data.margin_pct)
                        ? `${hover.data.margin_pct!.toFixed(1)}%`
                        : '--'}
                    </div>
                  </div>

                  {hover.data.alleviation && (
                    <div className="mt-3">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-[#7A3A1A] font-semibold">
                        Recommended Alleviation
                      </div>
                      <div className="mt-1 text-xs text-slate-200">
                        {hover.data.alleviation}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-[#7A3A1A] font-semibold">
                    Bus
                  </div>
                  <div className="mt-1 text-sm font-semibold text-[#FFE65C]">
                    {hover.data.labelText ?? hover.data.id}
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div className="text-[#7A3A1A]">Voltage</div>
                    <div className="text-slate-100 font-mono">
                      {Number.isFinite(hover.data.v_pu)
                        ? `${hover.data.v_pu!.toFixed(3)} p.u.`
                        : '--'}
                    </div>
                    <div className="text-[#7A3A1A]">Delta</div>
                    <div className="text-slate-100 font-mono">
                      {(() => {
                        if (!Number.isFinite(hover.data.v_pu)) return '--';
                        const vpu = hover.data.v_pu as number;
                        if (vpu < V_MIN) return `${(vpu - V_MIN).toFixed(3)} below`;
                        if (vpu > V_MAX) return `${(vpu - V_MAX).toFixed(3)} above`;
                        return 'within band';
                      })()}
                    </div>
                  </div>
                  {(() => {
                    if (!Number.isFinite(hover.data.v_pu)) return null;
                    const vpu = hover.data.v_pu as number;
                    if (vpu < V_MIN) {
                      return (
                        <div className="mt-3 text-xs text-slate-200">
                          Recommended: increase reactive support or curtail load at this bus.
                        </div>
                      );
                    }
                    if (vpu > V_MAX) {
                      return (
                        <div className="mt-3 text-xs text-slate-200">
                          Recommended: curtail PV output or shift load toward this feeder.
                        </div>
                      );
                    }
                    return null;
                  })()}
                </>
              )}
            </div>
          </div>
        )}

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
