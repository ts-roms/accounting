'use client';
import { useParams } from 'next/navigation';
import { ExpenseClaimDetailPage } from '@/components/budgeting/expense-claims';

export default function ExpenseClaimRoute() {
  const params = useParams<{ id: string }>();
  return <ExpenseClaimDetailPage id={params.id} />;
}
