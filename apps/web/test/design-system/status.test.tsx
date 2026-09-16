import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HealthIndicator, StatusBadge, StatusDot } from '@accounting/ui';
import {
  ApprovalStatus,
  FinancialStatus,
  IntegrationStatus,
  JournalStatus,
  PaymentStatus,
  PeriodStatus,
  ReconciliationStatus,
  toneOf,
} from '@/components/status';

describe('status language', () => {
  it('renders tone + icon + text so meaning never depends on colour alone', () => {
    const { container } = render(<StatusBadge tone="positive">Posted</StatusBadge>);
    const badge = screen.getByText('Posted').closest('[data-tone]');
    expect(badge).toHaveAttribute('data-tone', 'positive');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('falls back to a dot when no icon is wanted', () => {
    const { container } = render(
      <StatusBadge tone="neutral" icon={false}>
        Draft
      </StatusBadge>,
    );
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('.rounded-full')).not.toBeNull();
  });

  it('maps legacy badge variants onto semantic tones', () => {
    expect(toneOf('success')).toBe('positive');
    expect(toneOf('destructive')).toBe('critical');
    expect(toneOf('warning')).toBe('warning');
    expect(toneOf('default')).toBe('info');
    expect(toneOf('outline')).toBe('neutral');
  });

  it('domain statuses carry consistent tones', () => {
    render(
      <>
        <JournalStatus status="POSTED" />
        <FinancialStatus status="UNPOSTED" />
        <ApprovalStatus status="REJECTED" />
        <PaymentStatus status="VOID" />
        <ReconciliationStatus status="HAS_VARIANCE" />
        <IntegrationStatus status="SYNCING" />
        <PeriodStatus status="LOCKED" />
      </>,
    );
    expect(screen.getByText('Posted').closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'positive',
    );
    expect(screen.getByText('Unposted').closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'pending',
    );
    expect(screen.getByText('Rejected').closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'critical',
    );
    expect(screen.getByText('Void').closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'critical',
    );
    expect(screen.getByText('Has Variance').closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'critical',
    );
    expect(screen.getByText('Syncing').closest('[data-tone]')).toHaveAttribute('data-tone', 'info');
    expect(screen.getByText('Locked').closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'neutral',
    );
  });

  it('exposes dots and health indicators to assistive technology', () => {
    render(
      <>
        <StatusDot tone="critical" label="Overdue" />
        <HealthIndicator tone="positive" label="Healthy" description="All controls pass" />
      </>,
    );
    expect(screen.getByRole('img', { name: 'Overdue' })).toBeInTheDocument();
    expect(screen.getByText('Healthy').closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'positive',
    );
  });
});
