'use client';
import * as React from 'react';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import { Button } from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { downloadExport } from '@/lib/api/data-infrastructure-hooks';
import type { ExportDataset } from '@/lib/api/types';
import { Can } from '@/components/ui-ext/page';

/** "Export CSV" action for a report or list; hidden without `reports.export`. */
export function ExportButton({
  dataset,
  query,
  label = 'Export CSV',
}: {
  dataset: ExportDataset;
  query?: Record<string, string | undefined>;
  label?: string;
}) {
  const [busy, setBusy] = React.useState(false);
  return (
    <Can permissions={[P['reports.export']]}>
      <Button
        variant="outline"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await downloadExport(dataset, query);
          } catch (err) {
            toast.error(describeError(err));
          } finally {
            setBusy(false);
          }
        }}
        data-testid={`export-${dataset.toLowerCase()}`}
      >
        <Download /> {label}
      </Button>
    </Can>
  );
}
