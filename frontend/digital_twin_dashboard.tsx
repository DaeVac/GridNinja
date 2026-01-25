import React, { useState, useEffect } from 'react';
import { LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar } from 'recharts';
import { Activity, Zap, AlertTriangle, TrendingUp, Flame, Battery, Gauge, CloudRain } from 'lucide-react';

export default function DigitalTwinDashboard() {
  const [timeRange, setTimeRange] = useState('24h');
  const [pulseIntensity, setPulseIntensity] = useState(1);

  // Simulate real-time pulse effect
  useEffect(() => {
    const interval = setInterval(() => {
      setPulseIntensity(prev => (prev === 1 ? 1.2 : 1));
    }, 1500);
    return () => clearInterval(interval);
  }, []);

  // A. Physical State - Fast, Dangerous (Real-time data)
  const physicalState = [
    { metric: 'Power', value: 487.3, unit: 'MW', status: 'critical', icon: Zap },
    { metric: 'Voltage', value: 13.8, unit: 'kV', status: 'normal', icon: Activity },
    { metric: 'Temperature', value: 78.2, unit: '°C', status: 'warning', icon: Flame },
    { metric: 'Battery SoC', value: 82.5, unit: '%', status: 'normal', icon: Battery },
  ];

  const flowRates = [
    { time: '00:00', cooling: 1250, process: 890, return: 1180 },
    { time: '04:00', cooling: 1220, process: 910, return: 1165 },
    { time: '08:00', cooling: 1380, process: 1020, return: 1295 },
    { time: '12:00', cooling: 1420, process: 1080, return: 1340 },
    { time: '16:00', cooling: 1360, process: 980, return: 1280 },
    { time: '20:00', cooling: 1280, process: 920, return: 1210 },
    { time: '24:00', cooling: 1240, process: 900, return: 1175 },
  ];

  // B. Derived Efficiency - Medium Speed
  const efficiencyMetrics = [
    { metric: 'PUE', value: 1.38, target: 1.20, status: 'warning' },
    { metric: 'COP', value: 3.82, target: 4.00, status: 'normal' },
    { metric: 'WUE', value: 1.42, target: 1.20, status: 'warning' },
    { metric: 'Losses', value: 8.7, target: 5.0, status: 'critical' },
  ];

  // C. Environmental Impact - Slow, Strategic
  const carbonData = [
    { time: '00:00', intensity: 420, workload: 0.85, cumulative: 12450 },
    { time: '04:00', intensity: 380, workload: 0.76, cumulative: 12530 },
    { time: '08:00', intensity: 460, workload: 0.98, cumulative: 12680 },
    { time: '12:00', intensity: 510, workload: 1.12, cumulative: 12850 },
    { time: '16:00', intensity: 485, workload: 1.02, cumulative: 13010 },
    { time: '20:00', intensity: 445, workload: 0.91, cumulative: 13140 },
    { time: '24:00', intensity: 410, workload: 0.82, cumulative: 13240 },
  ];

  // D. Risk / Prediction
  const riskMetrics = [
    { component: 'HVAC-1', ttf: 720, exceedance: 12, forecast: 'stable' },
    { component: 'Transformer-A', ttf: 2160, exceedance: 5, forecast: 'declining' },
    { component: 'Battery Bank', ttf: 4320, exceedance: 3, forecast: 'stable' },
    { component: 'Cooling Pump', ttf: 168, exceedance: 45, forecast: 'critical' },
  ];

  const predictionRadar = [
    { metric: 'Thermal', current: 78, forecast: 85, max: 100 },
    { metric: 'Load', current: 72, forecast: 88, max: 100 },
    { metric: 'Efficiency', current: 85, forecast: 78, max: 100 },
    { metric: 'Reliability', current: 92, forecast: 88, max: 100 },
    { metric: 'Carbon', current: 68, forecast: 72, max: 100 },
  ];

  const getStatusColor = (status) => {
    switch(status) {
      case 'critical': return '#E10600';
      case 'warning': return '#FF5A00';
      default: return '#FFD400';
    }
  };

  return (
    <div className="min-h-screen bg-black text-slate-100 p-6">
      {/* Ambient glow effects - layered for depth */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 right-1/4 w-96 h-96 bg-[#E10600] opacity-10 blur-3xl rounded-full animate-pulse"></div>
        <div className="absolute bottom-1/4 left-1/4 w-96 h-96 bg-[#FFD400] opacity-5 blur-3xl rounded-full"></div>
        <div className="absolute top-1/2 left-1/2 w-64 h-64 bg-[#FF5A00] opacity-8 blur-2xl rounded-full"></div>
      </div>

      <div className="relative z-10">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <Flame className="w-8 h-8 text-[#E10600]" style={{ filter: 'drop-shadow(0 0 8px rgba(225, 6, 0, 0.6))' }} />
              <h1 className="text-3xl font-bold bg-gradient-to-r from-[#FFD400] via-[#FF5A00] to-[#E10600] bg-clip-text text-transparent">
                Digital Twin Monitor
              </h1>
            </div>
            <div className="flex items-center gap-2 bg-[#120805] border border-[#E10600]/30 rounded-full px-4 py-2">
              <div 
                className="w-2 h-2 rounded-full bg-[#E10600] transition-all duration-300"
                style={{ 
                  transform: `scale(${pulseIntensity})`,
                  boxShadow: `0 0 ${8 * pulseIntensity}px rgba(225, 6, 0, 0.8)`
                }}
              ></div>
              <span className="text-sm text-[#FFE65C]">Live Sync Active</span>
            </div>
          </div>
          <p className="text-[#7A3A1A]">Real-time monitoring • Carbon emissions • Predictive analytics</p>
        </div>

        {/* A. PHYSICAL STATE - Fast, Dangerous (Intense Glow) */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-[#E10600] mb-4 flex items-center gap-2">
            <Gauge className="w-5 h-5" />
            Physical State (Real-time)
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {physicalState.map((stat, idx) => {
              const Icon = stat.icon;
              return (
                <div 
                  key={idx} 
                  className="bg-gradient-to-br from-[#120805] to-[#1A0B06] border rounded-lg p-4 transition-all shadow-lg"
                  style={{ 
                    borderColor: `${getStatusColor(stat.status)}40`,
                    boxShadow: `0 0 20px ${getStatusColor(stat.status)}20`
                  }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[#7A3A1A] text-sm font-medium">{stat.metric}</span>
                    <Icon 
                      className="w-4 h-4" 
                      style={{ 
                        color: getStatusColor(stat.status),
                        filter: `drop-shadow(0 0 4px ${getStatusColor(stat.status)})`
                      }} 
                    />
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span 
                      className="text-2xl font-bold transition-all"
                      style={{ 
                        color: getStatusColor(stat.status),
                        textShadow: `0 0 10px ${getStatusColor(stat.status)}60`
                      }}
                    >
                      {stat.value}
                    </span>
                    <span className="text-sm text-[#5A2A14]">{stat.unit}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Flow Rates Chart */}
        <div className="mb-6 bg-gradient-to-br from-[#120805] to-[#1A0B06] border border-[#3A1A0A] rounded-lg p-6 shadow-xl">
          <h3 className="text-lg font-semibold text-[#FFE65C] mb-4">Flow Rates (L/min)</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={flowRates}>
              <CartesianGrid strokeDasharray="3 3" stroke="#3A1A0A" />
              <XAxis dataKey="time" stroke="#7A3A1A" style={{ fontSize: '12px' }} />
              <YAxis stroke="#7A3A1A" style={{ fontSize: '12px' }} />
              <Tooltip 
                contentStyle={{ backgroundColor: '#120805', border: '1px solid #5A2A14', borderRadius: '8px' }}
                labelStyle={{ color: '#FFE65C' }}
              />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Line type="monotone" dataKey="cooling" stroke="#E10600" strokeWidth={2} dot={{ fill: '#E10600', r: 4 }} name="Cooling" />
              <Line type="monotone" dataKey="process" stroke="#FF5A00" strokeWidth={2} dot={{ fill: '#FF5A00', r: 4 }} name="Process" />
              <Line type="monotone" dataKey="return" stroke="#FFD400" strokeWidth={2} dot={{ fill: '#FFD400', r: 4 }} name="Return" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* B. DERIVED EFFICIENCY - Medium Speed (Smooth Glow) */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-[#FF5A00] mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5" />
            Derived Efficiency (Near Real-time)
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {efficiencyMetrics.map((metric, idx) => (
              <div key={idx} className="bg-gradient-to-br from-[#120805] to-[#1A0B06] border border-[#5A2A14] rounded-lg p-4">
                <div className="mb-3">
                  <div className="text-sm text-[#7A3A1A] mb-1">{metric.metric}</div>
                  <div className="text-2xl font-bold text-[#FFB800]">{metric.value}</div>
                  <div className="text-xs text-[#5A2A14]">Target: {metric.target}</div>
                </div>
                <div className="w-full bg-[#1A0B06] rounded-full h-1.5">
                  <div 
                    className="h-1.5 rounded-full transition-all duration-1000"
                    style={{ 
                      width: `${Math.min((metric.value / metric.target) * 100, 100)}%`,
                      backgroundColor: getStatusColor(metric.status),
                      boxShadow: `0 0 8px ${getStatusColor(metric.status)}60`
                    }}
                  ></div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* C. ENVIRONMENTAL IMPACT - Slow, Strategic (Atmospheric Glow) */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-[#FFD400] mb-4 flex items-center gap-2">
            <CloudRain className="w-5 h-5" />
            Environmental Impact (Strategic)
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-gradient-to-br from-[#120805] to-[#1A0B06] border border-[#3A1A0A] rounded-lg p-6 shadow-xl">
              <h3 className="text-sm font-semibold text-[#FFE65C] mb-4">Carbon Intensity (gCO₂/kWh)</h3>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={carbonData}>
                  <defs>
                    <linearGradient id="carbonGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#FFD400" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#FF5A00" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#3A1A0A" />
                  <XAxis dataKey="time" stroke="#7A3A1A" style={{ fontSize: '12px' }} />
                  <YAxis stroke="#7A3A1A" style={{ fontSize: '12px' }} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#120805', border: '1px solid #5A2A14', borderRadius: '8px' }}
                    labelStyle={{ color: '#FFE65C' }}
                  />
                  <Area type="monotone" dataKey="intensity" stroke="#FFD400" fillOpacity={1} fill="url(#carbonGradient)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-gradient-to-br from-[#120805] to-[#1A0B06] border border-[#3A1A0A] rounded-lg p-6 shadow-xl">
              <h3 className="text-sm font-semibold text-[#FFE65C] mb-4">Carbon Efficiency vs Standard</h3>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={carbonData}>
                  <defs>
                    <linearGradient id="standardGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#E10600" stopOpacity={0.2}/>
                      <stop offset="95%" stopColor="#9F0F05" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="optimizedGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#FFD400" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#FFB800" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#3A1A0A" />
                  <XAxis dataKey="time" stroke="#7A3A1A" style={{ fontSize: '12px' }} />
                  <YAxis stroke="#7A3A1A" style={{ fontSize: '12px' }} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#120805', border: '1px solid #5A2A14', borderRadius: '8px' }}
                    labelStyle={{ color: '#FFE65C' }}
                  />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  <Area type="monotone" dataKey="cumulative" stroke="#E10600" fillOpacity={1} fill="url(#standardGradient)" strokeWidth={2} name="Standard Twin" />
                  <Area type="monotone" dataKey="intensity" stroke="#FFD400" fillOpacity={1} fill="url(#optimizedGradient)" strokeWidth={2} name="Optimized Twin" />
                </AreaChart>
              </ResponsiveContainer>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="p-2 bg-[#1A0B06] rounded border border-[#3A1A0A] text-center">
                  <div className="text-xs text-[#7A3A1A] mb-1">Efficiency Gain</div>
                  <div className="text-lg font-bold text-[#FFD400]">32.4%</div>
                </div>
                <div className="p-2 bg-[#1A0B06] rounded border border-[#3A1A0A] text-center">
                  <div className="text-xs text-[#7A3A1A] mb-1">Carbon Saved</div>
                  <div className="text-lg font-bold text-[#FFB800]">4.28 <span className="text-xs">tCO₂</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* D. RISK / PREDICTION - Delayed Bloom */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-[#E10600] mb-4 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            Risk & Prediction (Forecasting)
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-gradient-to-br from-[#120805] to-[#1A0B06] border border-[#3A1A0A] rounded-lg p-6 shadow-xl">
              <h3 className="text-sm font-semibold text-[#FFE65C] mb-4">Time to Failure (hours)</h3>
              <div className="space-y-3">
                {riskMetrics.map((risk, idx) => (
                  <div key={idx} className="p-3 bg-[#1A0B06] rounded border border-[#3A1A0A]">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-sm text-[#FFE65C]">{risk.component}</span>
                      <span className={`text-xs px-2 py-1 rounded ${risk.exceedance > 30 ? 'bg-[#E10600]/20 text-[#E10600]' : risk.exceedance > 10 ? 'bg-[#FF5A00]/20 text-[#FF5A00]' : 'bg-[#FFD400]/20 text-[#FFD400]'}`}>
                        {risk.exceedance}% risk
                      </span>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-xl font-bold text-[#FFB800]">{risk.ttf}</span>
                      <span className="text-xs text-[#5A2A14]">hrs • {risk.forecast}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-gradient-to-br from-[#120805] to-[#1A0B06] border border-[#3A1A0A] rounded-lg p-6 shadow-xl">
              <h3 className="text-sm font-semibold text-[#FFE65C] mb-4">Performance Forecast</h3>
              <ResponsiveContainer width="100%" height={280}>
                <RadarChart data={predictionRadar}>
                  <PolarGrid stroke="#3A1A0A" />
                  <PolarAngleAxis dataKey="metric" stroke="#7A3A1A" style={{ fontSize: '11px' }} />
                  <PolarRadiusAxis stroke="#5A2A14" />
                  <Radar name="Current" dataKey="current" stroke="#FFD400" fill="#FFD400" fillOpacity={0.3} strokeWidth={2} />
                  <Radar name="Forecast" dataKey="forecast" stroke="#E10600" fill="#E10600" fillOpacity={0.2} strokeWidth={2} strokeDasharray="5 5" />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* System Alert */}
        <div className="bg-gradient-to-r from-[#E10600]/10 to-[#FF5A00]/10 border border-[#E10600]/40 rounded-lg p-4 flex items-start gap-3 shadow-lg">
          <AlertTriangle className="w-5 h-5 text-[#FFD400] flex-shrink-0 mt-0.5" style={{ filter: 'drop-shadow(0 0 6px rgba(255, 212, 0, 0.6))' }} />
          <div>
            <h3 className="font-semibold text-[#FFB800] mb-1">Predictive Alert: Cooling Pump</h3>
            <p className="text-sm text-[#FFE65C]">Component shows 45% exceedance probability. Estimated TTF: 168 hours. Recommend immediate inspection.</p>
          </div>
        </div>
      </div>
    </div>
  );
}