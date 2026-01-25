import { renderHook, act } from '@testing-library/react'
import { useTelemetryWS } from '@/lib/telemetry/useTelemetryWS'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock WebSocket
class MockWebSocket {
    url: string;
    onopen: () => void = () => { };
    onmessage: (msg: any) => void = () => { };
    onclose: () => void = () => { };
    onerror: () => void = () => { };
    close = vi.fn();

    constructor(url: string) {
        this.url = url;
        setTimeout(() => this.onopen(), 10); // simulate async connect
    }
}

describe('useTelemetryWS', () => {
    let originalWS: any;

    beforeEach(() => {
        originalWS = global.WebSocket;
        global.WebSocket = MockWebSocket as any;
        vi.useFakeTimers();
    });

    afterEach(() => {
        global.WebSocket = originalWS;
        vi.useRealTimers();
    });

    it('connects to websocket on mount', async () => {
        const { result } = renderHook(() => useTelemetryWS());

        expect(result.current.status).toBe('connecting');

        // Fast-forward initial connect
        await act(async () => {
            vi.advanceTimersByTime(20);
        });

        expect(result.current.status).toBe('open');
    });
});
