'use client';
import * as React from 'react';
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@accounting/ui';
import { useAllIntegrationLogs, useIntegrations } from '@/lib/api/integrations-hooks';
import { PageHeader } from '@/components/ui-ext/page';
import { LogTable } from './integration-detail';

/** Organization-wide integration log: every operation with correlation id, status, latency and redacted metadata. */
export function IntegrationLogsPage() {
  const [integrationId, setIntegrationId] = React.useState('ALL');
  const [status, setStatus] = React.useState('ALL');
  const [direction, setDirection] = React.useState('ALL');
  const [search, setSearch] = React.useState('');
  const integrations = useIntegrations({ pageSize: 200 });
  const logs = useAllIntegrationLogs({
    pageSize: 100,
    integrationId: integrationId === 'ALL' ? undefined : integrationId,
    status: status === 'ALL' ? undefined : (status as never),
    direction: direction === 'ALL' ? undefined : (direction as never),
    search: search || undefined,
  });
  return (
    <>
      <PageHeader
        title="Integration logs"
        description="Structured trail of every integration operation. Credentials and tokens are redacted before anything is stored."
      />
      <div className="flex flex-wrap gap-2">
        <Select value={integrationId} onValueChange={setIntegrationId}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All integrations</SelectItem>
            {(integrations.data?.items ?? []).map((i) => (
              <SelectItem key={i.id} value={i.id}>
                {i.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={direction} onValueChange={setDirection}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">In + out</SelectItem>
            <SelectItem value="INBOUND">Inbound</SelectItem>
            <SelectItem value="OUTBOUND">Outbound</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All statuses</SelectItem>
            <SelectItem value="SUCCESS">Success</SelectItem>
            <SelectItem value="FAILURE">Failure</SelectItem>
            <SelectItem value="SKIPPED">Skipped</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="w-64"
          placeholder="Search operation, message, correlation..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <LogTable rows={logs.data?.items ?? []} showIntegration />
      <p className="text-xs text-muted-foreground">{logs.data?.total ?? 0} entries</p>
    </>
  );
}
