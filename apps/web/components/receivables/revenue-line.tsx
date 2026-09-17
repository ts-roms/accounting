'use client';
import * as React from 'react';
import Link from 'next/link';
import { Hourglass, Plus, Trash2 } from 'lucide-react';
import { formatMoney } from '@accounting/money';
import type { RevenueMilestone } from '@accounting/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from '@accounting/ui';
import { useRevenuePolicies, useRevenueSchedules } from '@/lib/api/revenue-hooks';
import { METHOD_LABEL } from '@/components/revenue/policies';

export interface RevenueLineValue {
  revenuePolicyId?: string | null;
  serviceStartDate?: string | null;
  serviceEndDate?: string | null;
  milestones?: RevenueMilestone[];
}

/**
 * AR-only line popover (Prompt #10): the recognition policy, the service
 * window for ratable lines and the milestone split for milestone lines.
 * Blank = the product's policy, else the company default.
 */
export function RevenueLinePopover({
  value,
  onChange,
  disabled,
}: {
  value: RevenueLineValue;
  onChange: (next: RevenueLineValue) => void;
  disabled?: boolean;
}) {
  const policies = useRevenuePolicies();
  const active = (policies.data ?? []).filter((p) => p.status === 'ACTIVE');
  const policy = active.find((p) => p.id === value.revenuePolicyId) ?? null;
  const milestones = value.milestones ?? [];
  const percentTotal = milestones.reduce((n, m) => n + Number(m.percent || 0), 0);
  const set = (patch: Partial<RevenueLineValue>) => onChange({ ...value, ...patch });
  const setMilestone = (i: number, patch: Partial<RevenueMilestone>) =>
    set({ milestones: milestones.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const count = (policy ? 1 : 0) + (value.serviceEndDate ? 1 : 0) + (milestones.length ? 1 : 0);
  if (!policies.data?.length) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={count ? 'secondary' : 'ghost'}
          size="sm"
          disabled={disabled}
          aria-label="Revenue recognition"
          data-testid="line-revenue"
          className={cn('gap-1 px-2', !count && 'text-muted-foreground')}
        >
          <Hourglass className="h-3.5 w-3.5" />
          {policy ? (
            <Badge variant="outline" className="px-1 text-[10px]">
              {policy.code}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        <p className="text-xs text-muted-foreground">
          Deferred lines credit deferred revenue when the invoice posts and are released by
          recognition runs. Blank uses the product&apos;s policy, else the company default.
        </p>
        <div className="space-y-1">
          <Label className="text-xs">Recognition policy</Label>
          <Select
            value={value.revenuePolicyId ?? 'DEFAULT'}
            onValueChange={(v) =>
              set({
                revenuePolicyId: v === 'DEFAULT' ? null : v,
                milestones:
                  active.find((p) => p.id === v)?.method === 'MILESTONE' ? milestones : [],
              })
            }
            disabled={disabled}
          >
            <SelectTrigger
              className="h-8"
              aria-label="Recognition policy"
              data-testid="line-revenue-policy"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="DEFAULT">Product / company default</SelectItem>
              {active.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.code} - {METHOD_LABEL[p.method]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!policy || policy.method !== 'MILESTONE' ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Service start</Label>
              <Input
                type="date"
                className="h-8"
                value={value.serviceStartDate ?? ''}
                onChange={(e) => set({ serviceStartDate: e.target.value || null })}
                disabled={disabled}
                data-testid="line-service-start"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Service end</Label>
              <Input
                type="date"
                className="h-8"
                value={value.serviceEndDate ?? ''}
                onChange={(e) => set({ serviceEndDate: e.target.value || null })}
                disabled={disabled}
                data-testid="line-service-end"
              />
            </div>
            {policy?.method === 'RATABLE' && !value.serviceEndDate ? (
              <p className="col-span-2 text-xs text-muted-foreground">
                {policy.defaultTermMonths
                  ? `No end date: ${policy.defaultTermMonths} months from the start (or the invoice date).`
                  : 'This policy has no default term - set a service end date.'}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Milestones (must total 100%)</Label>
              <span
                className={cn(
                  'text-xs',
                  percentTotal === 100 ? 'text-positive' : 'text-destructive',
                )}
              >
                {percentTotal}%
              </span>
            </div>
            {milestones.map((m, i) => (
              <div key={i} className="grid grid-cols-[1fr_4rem_7.5rem_auto] items-center gap-1">
                <Input
                  className="h-8"
                  placeholder="Name"
                  value={m.name}
                  onChange={(e) => setMilestone(i, { name: e.target.value })}
                  data-testid="milestone-name"
                />
                <Input
                  className="h-8"
                  inputMode="decimal"
                  placeholder="%"
                  value={m.percent}
                  onChange={(e) => setMilestone(i, { percent: e.target.value })}
                  data-testid="milestone-percent"
                />
                <Input
                  type="date"
                  className="h-8"
                  value={m.expectedDate ?? ''}
                  onChange={(e) => setMilestone(i, { expectedDate: e.target.value || null })}
                  aria-label="Expected date"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove milestone"
                  onClick={() => set({ milestones: milestones.filter((_, j) => j !== i) })}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="milestone-add"
              onClick={() =>
                set({ milestones: [...milestones, { name: '', percent: '', expectedDate: null }] })
              }
            >
              <Plus /> Add milestone
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Invoice detail card (AR only): the deferred revenue schedules the posted invoice created. */
export function InvoiceRevenueCard({ invoiceId }: { invoiceId: string }) {
  const schedules = useRevenueSchedules({ invoiceId, pageSize: 50 });
  const items = schedules.data?.items ?? [];
  if (items.length === 0) return null;
  const currency = items[0]!.currency;
  return (
    <Card data-testid="invoice-revenue-card">
      <CardHeader>
        <CardTitle className="text-sm">Deferred revenue</CardTitle>
        <CardDescription>
          Lines under a ratable or milestone policy credited deferred revenue; recognition runs
          release them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-2 text-sm">
            <div className="min-w-0">
              <Link href={`/revenue/schedules/${s.id}`} className="underline">
                {METHOD_LABEL[s.method]} - {s.policyCode}
              </Link>
              <div className="text-xs text-muted-foreground">
                {s.nextRecognitionDate ? `next ${s.nextRecognitionDate}` : s.status.toLowerCase()}
              </div>
            </div>
            <div className="text-right text-xs">
              <div>{formatMoney(s.recognizedAmount, currency)} recognized</div>
              <div className="text-muted-foreground">
                {formatMoney(s.remainingAmount, currency)} deferred
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
