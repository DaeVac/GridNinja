import { render, screen } from '@testing-library/react'
import { KpiCard } from '@/components/kpi/KpiCard'
import { describe, it, expect } from 'vitest'

describe('KpiCard', () => {
    it('renders title and value correctly', () => {
        render(<KpiCard title="Test Metric" value={1234} />)

        expect(screen.getByText('Test Metric')).toBeInTheDocument()
        expect(screen.getByText(/1,234/)).toBeInTheDocument() // default formatting
    })

    it('formats currency correctly', () => {
        render(<KpiCard title="Revenue" value={5000} format="currency" currency="USD" />)
        // Use regex to tolerate potential spacing/grouping differences
        expect(screen.getByText(/\$5,000/)).toBeInTheDocument()
    })

    it('renders positive delta with up arrow', () => {
        const { container } = render(<KpiCard title="Growth" value={100} delta={0.15} />)

        // 0.15 might be formatted as 15% or 15.0% depending on Intl defaults
        expect(screen.getByText(/\+15/)).toBeInTheDocument()
        expect(container.querySelector('.text-emerald-300')).toBeInTheDocument()
    })

    it('renders loading state', () => {
        render(<KpiCard title="Loading..." isLoading={true} />)
        expect(screen.getByLabelText('Loading KPI card')).toBeInTheDocument()
    })
})
