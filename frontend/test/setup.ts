import '@testing-library/jest-dom'
import { vi } from 'vitest'

// Mock ResizeObserver (needed for Recharts/ReactFlow/Three)
global.ResizeObserver = class ResizeObserver {
    observe() { }
    unobserve() { }
    disconnect() { }
}

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(query => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(), // deprecated
        removeListener: vi.fn(), // deprecated
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    })),
})

// Mock Canvas (Three.js dependency)
HTMLCanvasElement.prototype.getContext = vi.fn();
