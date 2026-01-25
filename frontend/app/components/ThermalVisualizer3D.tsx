'use client';

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Float, ContactShadows, Environment, Html } from '@react-three/drei';
import * as THREE from 'three';
import clsx from 'clsx';
import { Thermometer, Wind, AlertTriangle } from 'lucide-react';

const RAW_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000';

type Telemetry = {
    rack_temp_c: number;
    cooling_kw: number;
    ts?: number;
};

type StreamStatus = 'connecting' | 'open' | 'error';

function sanitizeBaseUrl(url: string) {
    // Avoid accidental trailing slashes that can create double-slashes in logs
    return url.replace(/\/+$/, '');
}

function useTelemetryStream(apiBase: string) {
    const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
    const [status, setStatus] = useState<StreamStatus>('connecting');

    useEffect(() => {
        let es: EventSource | null = null;
        let alive = true;
        let retry = 0;

        const connect = () => {
            if (!alive) return;

            setStatus('connecting');

            // Safe URL join
            const url = new URL('/telemetry/stream', apiBase);
            url.searchParams.set('dt', '1.0');

            es = new EventSource(url.toString());

            es.onopen = () => {
                retry = 0;
                setStatus('open');
            };

            es.onmessage = (event) => {
                try {
                    const d = JSON.parse(event.data) as Telemetry;
                    // Guard against unexpected payloads
                    if (
                        typeof d?.rack_temp_c === 'number' &&
                        typeof d?.cooling_kw === 'number'
                    ) {
                        setTelemetry(d);
                    }
                } catch {
                    // Avoid console spam from malformed SSE data bursts
                }
            };

            es.onerror = () => {
                setStatus('error');
                es?.close();
                es = null;

                retry += 1;
                // Exponential backoff with cap
                const delay = Math.min(5000, 250 * 2 ** retry);
                window.setTimeout(connect, delay);
            };
        };

        connect();

        return () => {
            alive = false;
            es?.close();
        };
    }, [apiBase]);

    return { telemetry, status };
}

function useSmoothedValue(target: number, alpha = 0.18) {
    const [value, setValue] = useState(target);

    useEffect(() => {
        setValue((prev) => prev + (target - prev) * alpha);
    }, [target, alpha]);

    return value;
}

// --- Server Rack Mesh ---
function ServerRack({ tempC }: { tempC: number }) {
    // Color Logic: Blue(20C) -> Green(35C) -> Red(50C)
    const color = useMemo(() => {
        const t = THREE.MathUtils.clamp(tempC, 20, 50);
        const safe = new THREE.Color('#3b82f6'); // Blue-500
        const mid = new THREE.Color('#10b981');  // Emerald-500
        const hot = new THREE.Color('#ef4444');  // Red-500

        if (t <= 35) {
            const alpha = (t - 20) / 15;
            return safe.clone().lerp(mid, alpha);
        } else {
            const alpha = (t - 35) / 15; // reaches red at 50
            return mid.clone().lerp(hot, alpha);
        }
    }, [tempC]);

    const lightRef = useRef<THREE.PointLight>(null);

    useFrame((state) => {
        const light = lightRef.current;
        if (!light) return;

        if (tempC > 45) {
            const base = 2.0;
            const pulse = Math.sin(state.clock.elapsedTime * 8) * 1.0;
            light.intensity = THREE.MathUtils.clamp(base + pulse, 1.5, 3.0);
        } else {
            light.intensity = 1.0;
        }
    });

    const isHot = tempC > 45;

    return (
        <group position={[0, 0, 0]}>
            {/* Rack Frame */}
            <mesh position={[0, 1.5, 0]} castShadow receiveShadow>
                <boxGeometry args={[1.2, 3, 1.2]} />
                <meshStandardMaterial
                    color="#1e293b"
                    roughness={0.2}
                    metalness={0.8}
                />
            </mesh>

            {/* Server Units (Glowing Front Panel) */}
            <mesh position={[0, 1.5, 0.61]}>
                <planeGeometry args={[1, 2.8]} />
                <meshStandardMaterial
                    color={color}
                    emissive={color}
                    emissiveIntensity={isHot ? 2.0 : 0.6}
                    toneMapped={false}
                />
            </mesh>

            {/* Internal "Heat" Light */}
            <pointLight
                ref={lightRef}
                position={[0, 1.5, 1]}
                distance={3}
                color={color}
            />

            {/* Status Text Floating Above */}
            <Float speed={2} rotationIntensity={0.2} floatIntensity={0.5}>
                <group position={[0, 3.8, 0]}>
                    <Html center transform style={{ pointerEvents: 'none' }}>
                        <div
                            className={clsx(
                                'px-3 py-1.5 rounded-full border shadow-lg backdrop-blur-md flex items-center gap-2',
                                isHot
                                    ? 'bg-red-500/20 border-red-500 text-red-100'
                                    : 'bg-white/10 border-white/20 text-white'
                            )}
                        >
                            <Thermometer className="w-4 h-4" />
                            <span className="font-mono font-bold text-lg">
                                {tempC.toFixed(1)}°C
                            </span>
                        </div>
                    </Html>
                </group>
            </Float>
        </group>
    );
}

// --- Floor & Environment ---
function SceneSetup() {
    return (
        <>
            <ambientLight intensity={0.55} />
            <spotLight
                position={[10, 10, 10]}
                angle={0.18}
                penumbra={1}
                intensity={1}
                castShadow
            />

            <Suspense fallback={null}>
                <Environment preset="city" />
            </Suspense>

            <ContactShadows
                position={[0, 0, 0]}
                opacity={0.5}
                scale={10}
                blur={2.5}
                far={4}
            />

            <gridHelper
                args={[20, 20, '#334155', '#1e293b']}
                position={[0, -0.01, 0]}
            />
        </>
    );
}

// --- Main Visualizer ---
export default function ThermalVisualizer3D() {
    const apiBase = useMemo(() => sanitizeBaseUrl(RAW_API_BASE), []);
    const { telemetry, status } = useTelemetryStream(apiBase);

    const tempRaw = telemetry?.rack_temp_c ?? 25.0;
    const coolingKwRaw = telemetry?.cooling_kw ?? 0.0;

    // Smooth only the visuals (prevents flicker)
    const tempSmooth = useSmoothedValue(tempRaw, 0.18);

    const isHot = tempRaw > 45;

    return (
        <div className="w-full h-screen bg-slate-900 relative">
            <Canvas shadows camera={{ position: [4, 4, 6], fov: 50 }} dpr={[1, 2]}>
                <SceneSetup />
                <ServerRack tempC={tempSmooth} />
                <OrbitControls minPolarAngle={0} maxPolarAngle={Math.PI / 2} />
            </Canvas>

            {/* HUD Overlay */}
            <div className="absolute top-6 left-6 space-y-4 pointer-events-none">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-bold text-white tracking-tight">
                            Digital Twin: Thermal
                        </h1>
                        <p className="text-slate-400 text-sm">Real-time physics simulation</p>
                    </div>

                    {/* Connection status pill */}
                    <div
                        className={clsx(
                            'px-3 py-1 rounded-full border text-xs font-semibold backdrop-blur',
                            status === 'open' && 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
                            status === 'connecting' && 'bg-slate-500/15 border-slate-500/30 text-slate-200',
                            status === 'error' && 'bg-red-500/15 border-red-500/40 text-red-200'
                        )}
                    >
                        {status === 'open' && 'LIVE'}
                        {status === 'connecting' && 'CONNECTING'}
                        {status === 'error' && 'RECONNECTING'}
                    </div>
                </div>

                <div className="bg-slate-800/80 p-4 rounded-lg border border-slate-700 backdrop-blur">
                    <div className="flex items-center gap-3 mb-2">
                        <Wind className="text-blue-400 w-5 h-5" />
                        <span className="text-slate-200 text-sm font-medium">
                            Cooling Power
                        </span>
                    </div>
                    <div className="text-2xl font-mono text-white">
                        {coolingKwRaw.toFixed(1)}{' '}
                        <span className="text-base text-slate-500">kW</span>
                    </div>
                </div>

                {isHot && (
                    <div className="bg-red-500/20 p-4 rounded-lg border border-red-500/50 backdrop-blur animate-pulse">
                        <div className="flex items-center gap-3">
                            <AlertTriangle className="text-red-500 w-6 h-6" />
                            <div>
                                <div className="text-red-200 font-bold">Overheat Warning</div>
                                <div className="text-red-300 text-xs">
                                    Rack temperature critical
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
