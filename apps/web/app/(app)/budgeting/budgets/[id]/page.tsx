'use client';
import { useParams } from 'next/navigation';
import { BudgetDetailPage } from '@/components/budgeting/budgets';

export default function BudgetRoute() {
  const params = useParams<{ id: string }>();
  return <BudgetDetailPage id={params.id} />;
}
