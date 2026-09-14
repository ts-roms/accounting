'use client';
import { usePathname } from 'next/navigation';
import { Construction } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui-ext/page';
import { findNavItem } from '@/lib/navigation';

const PHASES: Record<number, string> = {
  2: 'Accounting Core - chart of accounts, journals, posting engine, general ledger, trial balance, period close',
  3: 'AR / AP - customers, vendors, invoices, bills, payments, allocations, aging',
  4: 'Sales & Purchasing - orders, receiving, three-way matching, returns',
  5: 'Inventory - products, warehouses, movements, valuation, COGS',
  6: 'Assets & Banking - fixed assets, depreciation, bank transactions, reconciliation',
  7: 'Budgeting, Cost Accounting & Tax',
  8: 'Advanced Enterprise - multi-currency, consolidation, intercompany',
};

/** Roadmap placeholder for modules that are not implemented yet. */
export default function ModulePlaceholderPage() {
  const pathname = usePathname();
  const match = findNavItem(pathname);
  const title = match?.item.title ?? 'Not available';
  const phase = match?.item.phase;

  return (
    <>
      <PageHeader title={title} description={match ? `${match.section.title} module` : undefined} />
      <EmptyState
        icon={Construction}
        title={phase ? `Planned for Phase ${phase}` : 'This page does not exist'}
        description={
          phase
            ? `${PHASES[phase] ?? ''}. The foundation (Phase 1) is complete; this module will be built on top of the posting engine so every figure traces back to the general ledger.`
            : 'Check the navigation for available pages.'
        }
      />
    </>
  );
}
