'use client';
import { useParams } from 'next/navigation';
import { EmployeeDetailPage } from '@/components/payroll/employees';

export default function Page() {
  const params = useParams<{ id: string }>();
  return <EmployeeDetailPage id={params.id} />;
}
