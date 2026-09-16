import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  AnimatedNumber,
  AnimatedProgress,
  Button,
  MOTION_MS,
  OperationProgress,
  PageTransition,
  StepTimeline,
  readMotionMs,
} from '@accounting/ui';

vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
  setTimeout(() => cb(performance.now()), 0),
);
vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));

const reduced = (matches: boolean) =>
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query.includes('reduced-motion') ? matches : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });

describe('motion layer', () => {
  beforeEach(() => reduced(false));

  it('motion tokens are centralised and readable from JavaScript', () => {
    expect(MOTION_MS).toEqual({ fast: 100, normal: 150, medium: 200, slow: 400, data: 700 });
    // jsdom has no stylesheet: falls back to the documented defaults.
    expect(readMotionMs('data')).toBe(700);
  });

  it('AnimatedNumber always exposes the final value to assistive technology', () => {
    render(<AnimatedNumber value={1250000} format={(v) => `₱${Math.round(v).toLocaleString()}`} />);
    expect(screen.getByLabelText('₱1,250,000')).toBeInTheDocument();
  });

  it('AnimatedNumber renders the final value immediately under reduced motion', () => {
    reduced(true);
    render(<AnimatedNumber value={42} />);
    expect(screen.getByLabelText('42').querySelector('[aria-hidden]')).toHaveTextContent('42');
  });

  it('AnimatedProgress is a labelled progressbar with clamped values', () => {
    render(<AnimatedProgress value={140} label="Matched lines" />);
    const bar = screen.getByRole('progressbar', { name: 'Matched lines' });
    expect(bar).toHaveAttribute('aria-valuenow', '100');
  });

  it('page transitions re-run when the route key changes', () => {
    const { container, rerender } = render(
      <PageTransition routeKey="/a">
        <p>A</p>
      </PageTransition>,
    );
    const first = container.firstElementChild;
    expect(first).toHaveClass('animate-enter');
    rerender(
      <PageTransition routeKey="/b">
        <p>B</p>
      </PageTransition>,
    );
    expect(container.firstElementChild).not.toBe(first);
  });

  it('buttons block duplicate submissions while loading', () => {
    render(
      <Button loading loadingText="Posting...">
        Post journal
      </Button>,
    );
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toHaveTextContent('Posting...');
  });
});

describe('workflow components', () => {
  const steps = [
    { key: 'validate', label: 'Validating journal' },
    { key: 'period', label: 'Checking accounting period' },
    { key: 'post', label: 'Posting transaction' },
  ];

  it('marks every step done and shows the result when the operation succeeds', () => {
    render(<OperationProgress title="Post journal" steps={steps} phase="done" result="Posted" />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(['done', 'done', 'done']);
    expect(screen.getByText('Posted')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('completed');
  });

  it('points at the failing check and leaves later steps pending', () => {
    render(
      <OperationProgress
        steps={steps}
        phase="failed"
        failedStep="period"
        failureDetail="Period is closed"
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(['done', 'failed', 'pending']);
    expect(screen.getByText('Period is closed')).toBeInTheDocument();
  });

  it('runs every step together while the single transaction is in flight', () => {
    render(<OperationProgress steps={steps} phase="running" />);
    expect(screen.getAllByRole('listitem').every((li) => li.dataset.state === 'running')).toBe(
      true,
    );
  });

  it('timeline exposes the current step and completed markers', () => {
    render(
      <StepTimeline
        animate={false}
        steps={[
          { key: 'a', label: 'Created', state: 'complete' },
          { key: 'b', label: 'Submitted', state: 'current' },
          { key: 'c', label: 'Posted', state: 'upcoming' },
        ]}
      />,
    );
    const current = screen.getByText('Submitted').closest('li');
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(screen.getAllByText('Completed', { selector: '.sr-only' })).toHaveLength(1);
  });
});
