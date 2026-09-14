import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState, PageHeader } from './page';

describe('page primitives', () => {
  it('renders the page header with description and actions', () => {
    render(<PageHeader title="Users" description="People" actions={<button>New</button>} />);
    expect(screen.getByRole('heading', { name: 'Users' })).toBeInTheDocument();
    expect(screen.getByText('People')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
  });

  it('renders an empty state', () => {
    render(<EmptyState title="Nothing here" description="Try again" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText('Try again')).toBeInTheDocument();
  });
});
