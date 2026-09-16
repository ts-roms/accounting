import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  AccountCode,
  CurrencyDisplay,
  DeltaIndicator,
  PercentageDisplay,
  currencySymbol,
} from '@/components/financial/display';
import { FinancialMetricCard } from '@/components/financial/metric-card';

describe('financial number formatting', () => {
  it('resolves currency symbols', () => {
    expect(currencySymbol('PHP')).toBe('₱');
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('XXX')).toBe('XXX');
  });

  it('table variant keeps the accounting convention (parentheses)', () => {
    render(<CurrencyDisplay value="-32500.00" currency="PHP" />);
    expect(screen.getByText('(32,500.00)')).toBeInTheDocument();
  });

  it('metric variant prefixes the symbol and signs negatives explicitly', () => {
    render(<CurrencyDisplay value="-32500.00" currency="PHP" variant="metric" />);
    const sr = screen.getByText('-₱32,500.00');
    expect(sr).toHaveClass('sr-only');
    expect(sr.parentElement).toHaveClass('text-critical');
    expect(sr.previousElementSibling).toHaveTextContent('32,500.00');
  });

  it('shows an explicit plus for signed positives', () => {
    render(<CurrencyDisplay value="1250000.00" variant="metric" signed />);
    expect(screen.getByText('+₱1,250,000.00')).toBeInTheDocument();
  });

  it('percentages accept ratios and percent points', () => {
    const { rerender } = render(<PercentageDisplay value={0.1842} fractionDigits={2} />);
    expect(screen.getByText('18.42%')).toBeInTheDocument();
    rerender(<PercentageDisplay value="82" asRatio={false} fractionDigits={0} />);
    expect(screen.getByText('82%')).toBeInTheDocument();
  });

  it('delta indicator uses direction, arrow and text, not colour alone', () => {
    const { container, rerender } = render(<DeltaIndicator value={12.4} label="vs last month" />);
    expect(screen.getByText('Up', { selector: '.sr-only' })).toBeInTheDocument();
    expect(screen.getByText(/12\.4%/)).toBeInTheDocument();
    expect(screen.getByText('vs last month')).toBeInTheDocument();
    rerender(<DeltaIndicator value={-3} direction="down-is-good" />);
    expect(container.firstElementChild).toHaveClass('text-positive');
    rerender(<DeltaIndicator value={null} />);
    expect(screen.getByText('n/a')).toBeInTheDocument();
  });

  it('account codes are monospace', () => {
    render(<AccountCode code="1100" name="Cash" />);
    expect(screen.getByText('1100')).toHaveClass('font-mono');
  });

  it('metric card never fabricates: undefined renders a skeleton, message explains gaps', () => {
    const { container, rerender } = render(
      <FinancialMetricCard label="Revenue" value={undefined} />,
    );
    expect(container.querySelector('[aria-busy]')).not.toBeNull();
    rerender(
      <FinancialMetricCard label="Revenue" value={undefined} message="Reporting access required" />,
    );
    expect(screen.getByText('Reporting access required')).toBeInTheDocument();
    rerender(
      <FinancialMetricCard label="Revenue" value="2450000.00" delta={12.4} animate={false} />,
    );
    expect(screen.getByText('₱2,450,000.00')).toBeInTheDocument();
  });
});
