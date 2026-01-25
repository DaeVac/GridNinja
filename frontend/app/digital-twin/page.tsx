'use client';

import dynamic from 'next/dynamic';

const DigitalTwinDashboard = dynamic(() => import('../components/DigitalTwinDashboard'), {
    ssr: false,
    loading: () => (
        <div className="min-h-screen bg-black flex items-center justify-center">
            <div className="text-amber-400 text-xl animate-pulse">Loading Digital Twin...</div>
        </div>
    ),
});

export default function Page() {
    return <DigitalTwinDashboard />;
}
