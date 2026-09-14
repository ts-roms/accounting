import { redirect } from 'next/navigation';

/** The report view and the accounting view share one implementation. */
export default function ReportsGeneralLedgerPage() {
  redirect('/accounting/general-ledger');
}
