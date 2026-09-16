'use client';
import * as React from 'react';
import Link from 'next/link';
import { Bell, CheckCheck } from 'lucide-react';
import { P } from '@accounting/types';
import { Badge, Button, Popover, PopoverContent, PopoverTrigger } from '@accounting/ui';
import {
  useMarkNotificationsRead,
  useNotifications,
  useUnreadCount,
} from '@/lib/api/integrations-hooks';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/auth/session';

/** Header bell: unread count, the latest notifications and mark-as-read. */
export function NotificationsMenu() {
  const { hasPermission } = useSession();
  const enabled = hasPermission(P['notification.view']);
  const unread = useUnreadCount();
  const list = useNotifications(false);
  const mark = useMarkNotificationsRead();
  if (!enabled) return null;
  const count = unread.data?.count ?? 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Notifications"
          className="relative"
          data-testid="notifications-bell"
        >
          <Bell />
          {count > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-critical-foreground">
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Notifications</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => mark.mutate(undefined)}
            disabled={count === 0}
          >
            <CheckCheck /> Mark all read
          </Button>
        </div>
        <ul className="max-h-96 divide-y overflow-auto">
          {(list.data?.items ?? []).map((n) => (
            <li key={n.id} className={`px-3 py-2 text-sm ${n.readAt ? 'opacity-70' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        n.severity === 'ERROR'
                          ? 'destructive'
                          : n.severity === 'WARNING'
                            ? 'warning'
                            : 'secondary'
                      }
                    >
                      {n.severity}
                    </Badge>
                    {n.link ? (
                      <Link
                        href={n.link}
                        className="truncate font-medium hover:underline"
                        onClick={() => !n.readAt && mark.mutate(n.id)}
                      >
                        {n.title}
                      </Link>
                    ) : (
                      <span className="truncate font-medium">{n.title}</span>
                    )}
                  </div>
                  {n.body ? (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body}</p>
                  ) : null}
                  <div className="text-[10px] text-muted-foreground">
                    {formatDateTime(n.createdAt)}
                  </div>
                </div>
                {!n.readAt ? (
                  <Button variant="ghost" size="sm" onClick={() => mark.mutate(n.id)}>
                    Read
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
          {list.data && list.data.items.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              You are all caught up.
            </li>
          ) : null}
        </ul>
        <div className="border-t px-3 py-2 text-right">
          <Link href="/admin/notifications" className="text-xs underline">
            View all
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function NotificationsPage() {
  const list = useNotifications(false);
  const mark = useMarkNotificationsRead();
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Notifications</h1>
        <Button variant="outline" size="sm" onClick={() => mark.mutate(undefined)}>
          <CheckCheck /> Mark all read
        </Button>
      </div>
      <ul className="divide-y rounded-lg border">
        {(list.data?.items ?? []).map((n) => (
          <li
            key={n.id}
            className={`flex items-start justify-between gap-3 px-4 py-3 text-sm ${n.readAt ? 'opacity-70' : ''}`}
          >
            <div>
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    n.severity === 'ERROR'
                      ? 'destructive'
                      : n.severity === 'WARNING'
                        ? 'warning'
                        : 'secondary'
                  }
                >
                  {n.severity}
                </Badge>
                <span className="font-medium">{n.title}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{n.eventType}</span>
              </div>
              {n.body ? <p className="mt-0.5 text-xs text-muted-foreground">{n.body}</p> : null}
              <div className="text-[10px] text-muted-foreground">
                {formatDateTime(n.createdAt)}
                {n.link ? (
                  <>
                    {' '}
                    ·{' '}
                    <Link href={n.link} className="underline">
                      Open
                    </Link>
                  </>
                ) : null}
              </div>
            </div>
            {!n.readAt ? (
              <Button variant="ghost" size="sm" onClick={() => mark.mutate(n.id)}>
                Mark read
              </Button>
            ) : null}
          </li>
        ))}
        {list.data && list.data.items.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-muted-foreground">No notifications.</li>
        ) : null}
      </ul>
    </div>
  );
}
