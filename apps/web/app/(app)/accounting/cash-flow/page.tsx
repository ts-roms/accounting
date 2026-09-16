'use client';
import { redirect } from 'next/navigation';

/** Cash flow lives with the other statements; keep the direct route for bookmarks. */
export default function CashFlowRoute() {
  redirect('/reports/financial-statements?tab=cashflow');
}
