'use client';
import * as React from 'react';
import { Download, FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { ATTACHMENT_MAX_BYTES, P, type AttachmentEntityType } from '@accounting/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Skeleton,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  attachmentDownloadUrl,
  useAttachments,
  useDeleteAttachment,
  useUploadAttachment,
} from '@/lib/api/enterprise-hooks';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/auth/session';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Drop-in card listing a document's files with upload / download / delete. */
export function AttachmentsPanel({
  entityType,
  entityId,
}: {
  entityType: AttachmentEntityType;
  entityId: string;
}) {
  const { hasPermission } = useSession();
  const list = useAttachments(entityType, entityId);
  const upload = useUploadAttachment();
  const remove = useDeleteAttachment();
  const [description, setDescription] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  if (!hasPermission(P['attachment.view'])) return null;
  const canManage = hasPermission(P['attachment.manage']);
  const onFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (file.size > ATTACHMENT_MAX_BYTES) {
      toast.error(`Files are limited to ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB.`);
      return;
    }
    try {
      await upload.mutateAsync({
        entityType,
        entityId,
        file,
        description: description.trim() || undefined,
      });
      toast.success(`${file.name} attached.`);
      setDescription('');
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Card data-testid="attachments-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Paperclip className="h-4 w-4" /> Attachments
        </CardTitle>
        <CardDescription>
          PDF, images, spreadsheets and text up to {ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB; every
          file is checksummed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.isLoading ? (
          <Skeleton className="h-12" />
        ) : (list.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No files attached.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {list.data!.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-3 px-3 py-2 text-sm"
                data-testid="attachment-row"
              >
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{a.fileName}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {humanSize(a.sizeBytes)} · {a.uploadedByName ?? 'unknown'} ·{' '}
                    {formatDateTime(a.createdAt)}
                    {a.description ? ` · ${a.description}` : ''}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  asChild
                  aria-label={`Download ${a.fileName}`}
                >
                  <a href={attachmentDownloadUrl(a.id)} download={a.fileName}>
                    <Download />
                  </a>
                </Button>
                {canManage ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${a.fileName}`}
                    disabled={remove.isPending}
                    onClick={async () => {
                      try {
                        await remove.mutateAsync(a.id);
                      } catch (err) {
                        toast.error(describeError(err));
                      }
                    }}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional)"
              className="sm:flex-1"
            />
            <Input
              ref={inputRef}
              type="file"
              className="sm:w-72"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.txt,.xlsx,.docx"
              onChange={(e) => void onFiles(e.target.files)}
              disabled={upload.isPending}
              data-testid="attachment-file"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={upload.isPending}
              onClick={() => inputRef.current?.click()}
            >
              <Upload /> Upload
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
