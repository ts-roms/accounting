'use client';
/* TanStack Query hooks for payroll & employee expenses (Prompt #11). Company-scoped. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateEmployeeInput,
  CreatePayItemInput,
  CreatePayRunInput,
  EmployeePayItemInput,
  ListEmployeesQuery,
  ListPayRunsQuery,
  PayPayRunInput,
  PayrollSummaryQuery,
  ReversePayRunInput,
  SetPayRunInputsInput,
  UpdateEmployeeInput,
  UpdatePayItemInput,
  UpdatePayrollSettingsInput,
} from '@accounting/validation';
import { api } from './client';
import type {
  Employee,
  EmployeeDetail,
  EmployeeYtd,
  PayItem,
  PayRun,
  PayRunDetail,
  PayrollIntegrityReport,
  PayrollSettings,
  PayrollSummary,
  PayslipDetail,
  WithholdingRemittance,
} from './payroll-types';
import type { PaginatedResult } from './types';

const key = (...rest: unknown[]) => ['payroll', ...rest] as const;

/** Pay runs post journals and bank payments; claims can be settled through them. */
function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const k of [
    'payroll',
    'journal-entries',
    'general-ledger',
    'trial-balance',
    'expense-claims',
    'treasury',
    'banking',
  ])
    void qc.invalidateQueries({ queryKey: [k] });
}

// --------------------------------------------------------------- employees

export const useEmployees = (query: Partial<ListEmployeesQuery> = {}) =>
  useQuery({
    queryKey: key('employees', query),
    queryFn: () =>
      api.get<PaginatedResult<Employee>>('/employees', {
        query: query as Record<string, string | number | undefined>,
      }),
  });
export const useEmployee = (id: string | null) =>
  useQuery({
    queryKey: key('employee', id),
    queryFn: () => api.get<EmployeeDetail>(`/employees/${id}`),
    enabled: Boolean(id),
  });
export const useEmployeeYtd = (id: string | null, year?: number) =>
  useQuery({
    queryKey: key('employee-ytd', id, year),
    queryFn: () => api.get<EmployeeYtd>(`/employees/${id}/ytd`, { query: { year } }),
    enabled: Boolean(id),
  });
export const useCreateEmployee = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEmployeeInput) => api.post<EmployeeDetail>('/employees', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdateEmployee = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateEmployeeInput & { id: string }) =>
      api.patch<EmployeeDetail>(`/employees/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useAssignPayItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, ...input }: EmployeePayItemInput & { employeeId: string }) =>
      api.post<EmployeeDetail>(`/employees/${employeeId}/pay-items`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useRemovePayItemAssignment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, assignmentId }: { employeeId: string; assignmentId: string }) =>
      api.delete<EmployeeDetail>(`/employees/${employeeId}/pay-items/${assignmentId}`),
    onSuccess: () => invalidateAll(qc),
  });
};

// ----------------------------------------------------------- configuration

export const usePayrollSettings = () =>
  useQuery({
    queryKey: key('settings'),
    queryFn: () => api.get<PayrollSettings>('/payroll/settings'),
  });
export const useUpdatePayrollSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePayrollSettingsInput) =>
      api.put<PayrollSettings>('/payroll/settings', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const usePayItems = () =>
  useQuery({ queryKey: key('pay-items'), queryFn: () => api.get<PayItem[]>('/payroll/pay-items') });
export const useCreatePayItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePayItemInput) => api.post<PayItem>('/payroll/pay-items', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useUpdatePayItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdatePayItemInput & { id: string }) =>
      api.patch<PayItem>(`/payroll/pay-items/${id}`, input),
    onSuccess: () => invalidateAll(qc),
  });
};

// ---------------------------------------------------------------- pay runs

export const usePayRuns = (query: Partial<ListPayRunsQuery> = {}) =>
  useQuery({
    queryKey: key('runs', query),
    queryFn: () =>
      api.get<PaginatedResult<PayRun>>('/payroll/runs', {
        query: query as Record<string, string | number | undefined>,
      }),
  });
export const usePayRun = (id: string | null) =>
  useQuery({
    queryKey: key('run', id),
    queryFn: () => api.get<PayRunDetail>(`/payroll/runs/${id}`),
    enabled: Boolean(id),
  });
export const usePayslip = (id: string | null) =>
  useQuery({
    queryKey: key('payslip', id),
    queryFn: () => api.get<PayslipDetail>(`/payroll/payslips/${id}`),
    enabled: Boolean(id),
  });
export const useCreatePayRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePayRunInput) => api.post<PayRunDetail>('/payroll/runs', input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useSetPayRunInputs = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: SetPayRunInputsInput & { id: string }) =>
      api.put<PayRunDetail>(`/payroll/runs/${id}/inputs`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export type PayRunAction = 'calculate' | 'submit' | 'approve' | 'post';
export const usePayRunAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: PayRunAction }) =>
      api.post<PayRunDetail>(`/payroll/runs/${id}/${action}`, {}),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useReopenPayRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post<PayRunDetail>(`/payroll/runs/${id}/reopen`, { reason }),
    onSuccess: () => invalidateAll(qc),
  });
};
export const usePayPayRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: PayPayRunInput & { id: string }) =>
      api.post<PayRunDetail>(`/payroll/runs/${id}/pay`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useReversePayRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ReversePayRunInput & { id: string }) =>
      api.post<PayRunDetail>(`/payroll/runs/${id}/reverse`, input),
    onSuccess: () => invalidateAll(qc),
  });
};
export const useDeletePayRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/payroll/runs/${id}`),
    onSuccess: () => invalidateAll(qc),
  });
};

// ----------------------------------------------------------------- reports

export const usePayrollSummary = (query: PayrollSummaryQuery) =>
  useQuery({
    queryKey: key('summary', query),
    queryFn: () => api.get<PayrollSummary>('/payroll/reports/summary', { query }),
    enabled: Boolean(query.from && query.to),
  });
export const useWithholdingRemittance = (query: PayrollSummaryQuery) =>
  useQuery({
    queryKey: key('withholding', query),
    queryFn: () => api.get<WithholdingRemittance>('/payroll/reports/withholding', { query }),
    enabled: Boolean(query.from && query.to),
  });
export const usePayrollIntegrity = (asOf: string) =>
  useQuery({
    queryKey: key('integrity', asOf),
    queryFn: () => api.get<PayrollIntegrityReport>('/payroll/integrity', { query: { asOf } }),
  });
