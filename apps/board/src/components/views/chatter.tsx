import { Button } from '@moonwitness/ui/components/button';
import { Input } from '@moonwitness/ui/components/input';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@moonwitness/ui/components/toast';
import {
  Calendar,
  CheckCircle2,
  Clock,
  Download,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileText,
  History,
  Mail,
  MessageSquare,
  Paperclip,
  Phone,
  Plus,
  Trash2,
  UploadCloud,
  UserCheck,
  Zap,
} from 'lucide-react';
import { client } from '@/lib/client';
import { formatDateTime } from '@/lib/date-format';
import { scopedQueryKey } from '@/lib/query-scope';
import { useAuth } from '@/hooks/use-auth-context';
import { Textarea } from '@moonwitness/ui/components/textarea';
import { Label } from '@moonwitness/ui/components/label';
import { Doodle } from '@moonwitness/ui/components/effects';
import { cn } from '@/lib/utils';

interface ChatterProps {
  model: string;
  recordId: number;
}

interface ActivityRecord {
  id: number;
  summary: string;
  activity_type: 'todo' | 'call' | 'meeting' | 'email';
  state: 'planned' | 'done' | 'cancelled';
  deadline?: string;
  note?: string;
  assigned_to?: number | { id: number; name?: string; login?: string };
  create_date?: string;
}

interface AttachmentRecord {
  id: number;
  name: string;
  resource_model: string;
  resource_id: number;
  mimetype: string;
  size_bytes: number;
  checksum?: string;
  create_date?: string;
}

interface AuditLogRecord {
  id: number;
  model: string;
  record_id: number;
  operation: string;
  actor_id?: number;
  changes?: string;
  create_date?: string;
}

const TYPE_ICONS = {
  todo: CheckCircle2,
  call: Phone,
  meeting: Calendar,
  email: Mail,
};

const TYPE_COLORS = {
  todo: 'border-2 border-ink bg-lime text-on-accent',
  call: 'border-2 border-ink bg-paper-raised text-ink',
  meeting: 'border-2 border-ink bg-ink text-paper',
  email: 'border-2 border-ink bg-pink text-on-pink',
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(mimetype: string) {
  if (mimetype.startsWith('image/')) return FileImage;
  if (mimetype.includes('pdf') || mimetype.includes('text/')) return FileText;
  if (mimetype.includes('zip') || mimetype.includes('tar') || mimetype.includes('compressed'))
    return FileArchive;
  if (mimetype.includes('json') || mimetype.includes('javascript') || mimetype.includes('html'))
    return FileCode;
  return File;
}

export function Chatter({ model, recordId }: ChatterProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = user?.role === 'superadmin' || user?.role === 'system';

  const [activeTab, setActiveTab] = useState<'activities' | 'attachments' | 'audit'>('activities');
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // New activity form state
  const [newSummary, setNewSummary] = useState('');
  const [newType, setNewType] = useState<'todo' | 'call' | 'meeting' | 'email'>('todo');
  const [newDeadline, setNewDeadline] = useState(() =>
    new Date(now + 86400000).toISOString().slice(0, 10)
  );
  const [newNote, setNewNote] = useState('');

  // 1. Query activities for this specific record
  const { data: activitiesData, isLoading: activitiesLoading } = useQuery({
    queryKey: scopedQueryKey(['records', 'base.activity', 'for_record', model, recordId]),
    queryFn: () =>
      client.model<ActivityRecord>('base.activity').searchRead({
        domain: [
          ['resource_model', '=', model],
          ['resource_id', '=', recordId],
        ],
        order: 'deadline asc',
        limit: 50,
      }),
  });

  // 2. Query attachments for this record
  const { data: attachmentsData, isLoading: attachmentsLoading } = useQuery({
    queryKey: scopedQueryKey(['records', 'base.attachment', 'for_record', model, recordId]),
    queryFn: () =>
      client.model<AttachmentRecord>('base.attachment').searchRead({
        domain: [
          ['resource_model', '=', model],
          ['resource_id', '=', recordId],
        ],
        order: 'id desc',
        limit: 50,
      }),
  });

  // 3. Query audit logs for this specific record (admins only)
  const { data: auditData, isLoading: auditLoading } = useQuery({
    queryKey: scopedQueryKey(['records', 'base.audit_log', 'for_record', model, recordId]),
    queryFn: () =>
      client.model<AuditLogRecord>('base.audit_log').searchRead({
        domain: [
          ['model', '=', model],
          ['record_id', '=', recordId],
        ],
        order: 'id desc',
        limit: 50,
      }),
    enabled: isAdmin && activeTab === 'audit',
  });

  const handleCreateActivity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSummary.trim()) return;

    setSubmitting(true);
    try {
      await client.model('base.activity').create({
        resource_model: model,
        resource_id: recordId,
        summary: newSummary.trim(),
        activity_type: newType,
        deadline: newDeadline || undefined,
        note: newNote.trim() || undefined,
        state: 'planned',
      });
      queryClient.invalidateQueries({
        queryKey: ['records', 'base.activity'],
      });
      setNewSummary('');
      setNewNote('');
      setShowScheduleForm(false);
    } catch (err) {
      console.error('Failed to create activity:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleState = async (activity: ActivityRecord) => {
    const nextState = activity.state === 'done' ? 'planned' : 'done';
    try {
      await client.model('base.activity').write(activity.id, { state: nextState });
      queryClient.invalidateQueries({
        queryKey: ['records', 'base.activity'],
      });
    } catch (err) {
      console.error('Failed to update activity state:', err);
    }
  };

  const handleDeleteActivity = async (activityId: number) => {
    try {
      await client.model('base.activity').unlink(activityId, { hard: true });
      queryClient.invalidateQueries({
        queryKey: ['records', 'base.activity'],
      });
    } catch (err) {
      console.error('Failed to delete activity:', err);
    }
  };

  // Upload attachments handling
  const handleUploadFiles = async (files: FileList | File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      const fileList = Array.from(files);
      for (const file of fileList) {
        if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} exceeds the 10 MiB limit`);
        await client
          .model<AttachmentRecord>('base.attachment')
          .uploadAttachment(model, recordId, file);
      }
      queryClient.invalidateQueries({
        queryKey: ['records', 'base.attachment'],
      });
      toast.success(`${fileList.length} file${fileList.length === 1 ? '' : 's'} uploaded`);
    } catch (err) {
      console.error('Failed to upload attachments:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to upload attachment');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDeleteAttachment = async (attachmentId: number) => {
    try {
      await client.model('base.attachment').unlink(attachmentId, { hard: true });
      queryClient.invalidateQueries({
        queryKey: ['records', 'base.attachment'],
      });
    } catch (err) {
      console.error('Failed to delete attachment:', err);
    }
  };

  const handleDownloadAttachment = async (attachment: AttachmentRecord) => {
    try {
      const blob = await client
        .model<AttachmentRecord>('base.attachment')
        .downloadAttachment(attachment.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to download attachment:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to download attachment');
    }
  };

  const activities = activitiesData?.records ?? [];
  const plannedCount = activities.filter((a) => a.state === 'planned').length;
  const attachments = attachmentsData?.records ?? [];

  return (
    <div className="ink-panel border-4 border-ink bg-paper p-6 shadow-ink-lg space-y-6">
      {/* Hidden file input */}
      <Input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) handleUploadFiles(e.target.files);
        }}
      />

      {/* Header and Tab Selector */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b-2 border-ink pb-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 border-2 border-ink bg-lime px-2.5 py-1 font-mono text-xs font-bold uppercase tracking-wider text-on-accent">
            <Zap className="size-3.5" /> Record Chatter
          </div>
          <span className="font-mono text-xs text-ink-faint">
            {model} #{recordId}
          </span>
        </div>

        {/* Tab Switcher: Activities | Attachments | Audit Pulse */}
        <div className="flex items-center border-2 border-ink bg-card p-1">
          <Button
            type="button"
            onClick={() => setActiveTab('activities')}
            className={cn(
              'flex items-center gap-2 px-3 py-1 font-display text-xs uppercase tracking-wider transition-colors',
              activeTab === 'activities'
                ? 'border-2 border-ink bg-lime font-bold text-on-accent shadow-[2px_2px_0_0_var(--ink)]'
                : 'text-ink-soft hover:text-ink'
            )}
          >
            <Clock className="size-3.5" />
            Activities
            {plannedCount > 0 && (
              <span className="grid size-4 place-items-center border border-ink bg-pink text-[10px] font-bold text-on-pink shadow-[1px_1px_0_0_var(--ink)]">
                {plannedCount}
              </span>
            )}
          </Button>
          <Button
            type="button"
            onClick={() => setActiveTab('attachments')}
            className={cn(
              'flex items-center gap-2 px-3 py-1 font-display text-xs uppercase tracking-wider transition-colors',
              activeTab === 'attachments'
                ? 'border-2 border-ink bg-lime font-bold text-on-accent shadow-[2px_2px_0_0_var(--ink)]'
                : 'text-ink-soft hover:text-ink'
            )}
          >
            <Paperclip className="size-3.5" />
            Vault
            {attachments.length > 0 && (
              <span className="border border-ink bg-paper px-1 font-mono text-[10px] font-bold">
                {attachments.length}
              </span>
            )}
          </Button>
          <Button
            type="button"
            onClick={() => setActiveTab('audit')}
            className={cn(
              'flex items-center gap-2 px-3 py-1 font-display text-xs uppercase tracking-wider transition-colors',
              activeTab === 'audit'
                ? 'border-2 border-ink bg-lime font-bold text-on-accent shadow-[2px_2px_0_0_var(--ink)]'
                : 'text-ink-soft hover:text-ink'
            )}
          >
            <History className="size-3.5" />
            Audit Pulse
          </Button>
        </div>
      </div>

      {/* 1. Activities Tab */}
      {activeTab === 'activities' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="font-display text-lg uppercase tracking-wide">
                Scheduled Activities & Tasks
              </h3>
              <Doodle kind="sparkle" className="size-4 text-lime" />
            </div>
            <Button
              size="sm"
              variant={showScheduleForm ? 'outline' : 'default'}
              onClick={() => setShowScheduleForm((v) => !v)}
              className="gap-1.5"
            >
              <Plus className="size-4" />
              {showScheduleForm ? 'Cancel' : 'Schedule Activity'}
            </Button>
          </div>

          {/* Schedule Form */}
          {showScheduleForm && (
            <form
              onSubmit={handleCreateActivity}
              className="border-2 border-ink bg-card p-4 shadow-ink space-y-4"
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="act-summary" className="font-bold text-xs uppercase">
                    Summary / Task Title <span className="text-pink">*</span>
                  </Label>
                  <Input
                    id="act-summary"
                    required
                    placeholder="e.g. Follow up on contract negotiation"
                    value={newSummary}
                    onChange={(e) => setNewSummary(e.target.value)}
                    className="border-2 border-ink"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="act-type" className="font-bold text-xs uppercase">
                    Activity Type
                  </Label>
                  <div className="flex gap-2">
                    {(['todo', 'call', 'meeting', 'email'] as const).map((t) => {
                      const Icon = TYPE_ICONS[t];
                      return (
                        <Button
                          key={t}
                          type="button"
                          onClick={() => setNewType(t)}
                          className={cn(
                            'flex-1 flex items-center justify-center gap-1.5 border-2 border-ink py-1.5 text-xs font-bold uppercase transition-all',
                            newType === t
                              ? 'bg-lime text-on-accent shadow-[2px_2px_0_0_var(--ink)]'
                              : 'bg-paper text-ink-soft hover:bg-paper-raised'
                          )}
                        >
                          <Icon className="size-3.5" />
                          {t}
                        </Button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="act-deadline" className="font-bold text-xs uppercase">
                    Deadline (YYYY-MM-DD)
                  </Label>
                  <Input
                    id="act-deadline"
                    type="date"
                    value={newDeadline}
                    onChange={(e) => setNewDeadline(e.target.value)}
                    className="border-2 border-ink"
                  />
                </div>

                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="act-note" className="font-bold text-xs uppercase">
                    Optional Notes
                  </Label>
                  <Textarea
                    id="act-note"
                    placeholder="Add specific context, attendees, agenda or next steps..."
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    className="border-2 border-ink resize-none h-20 text-xs"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowScheduleForm(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={submitting}>
                  {submitting ? 'Scheduling...' : 'Save Activity'}
                </Button>
              </div>
            </form>
          )}

          {/* Activity Cards List */}
          {activitiesLoading ? (
            <div className="space-y-2">
              <div className="h-16 border-2 border-ink/20 bg-card/60 animate-pulse" />
              <div className="h-16 border-2 border-ink/20 bg-card/60 animate-pulse" />
            </div>
          ) : activities.length === 0 ? (
            <div className="border-2 border-dashed border-ink/30 bg-card/40 p-8 text-center">
              <MessageSquare className="mx-auto size-8 text-ink-faint mb-2" />
              <p className="font-display uppercase tracking-wide text-ink-soft">
                No activities planned yet
              </p>
              <p className="text-xs text-ink-faint mt-1">
                Schedule calls, todos, or meetings to track progress on this record.
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {activities.map((act) => {
                const Icon = TYPE_ICONS[act.activity_type] || CheckCircle2;
                const isDone = act.state === 'done';
                const isOverdue =
                  !isDone && act.deadline && new Date(act.deadline).getTime() < now - 86400000;

                return (
                  <div
                    key={act.id}
                    className={cn(
                      'border-2 border-ink p-3.5 transition-all flex items-start justify-between gap-3 shadow-ink-sm',
                      isDone
                        ? 'bg-card/50 opacity-60'
                        : isOverdue
                          ? 'bg-pink/10 border-pink'
                          : 'bg-paper hover:bg-paper-raised'
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <Button
                        type="button"
                        onClick={() => handleToggleState(act)}
                        className={cn(
                          'mt-0.5 grid size-5 place-items-center border-2 border-ink transition-colors',
                          isDone ? 'bg-lime text-on-accent' : 'bg-paper hover:bg-lime/30'
                        )}
                        title={isDone ? 'Mark as planned' : 'Mark as done'}
                      >
                        {isDone && <CheckCircle2 className="size-3.5" />}
                      </Button>

                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase',
                              TYPE_COLORS[act.activity_type]
                            )}
                          >
                            <Icon className="size-3" />
                            {act.activity_type}
                          </span>

                          <span
                            className={cn(
                              'font-bold text-sm',
                              isDone && 'line-through text-ink-faint'
                            )}
                          >
                            {act.summary}
                          </span>

                          {act.deadline && (
                            <span
                              className={cn(
                                'font-mono text-xs px-1.5 py-0.5 border',
                                isOverdue
                                  ? 'border-pink bg-pink text-on-pink font-bold'
                                  : 'border-ink/20 text-ink-faint'
                              )}
                            >
                              Due: {act.deadline}
                            </span>
                          )}
                        </div>

                        {act.note && (
                          <p className="text-xs text-ink-soft whitespace-pre-wrap pl-0.5">
                            {act.note}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteActivity(act.id)}
                        className="size-7 text-ink-faint hover:text-pink hover:bg-pink/10"
                        title="Delete activity"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 2. Attachments & Document Vault Tab */}
      {activeTab === 'attachments' && (
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="font-display text-lg uppercase tracking-wide">
                Document Vault & Attachments
              </h3>
              <Doodle kind="bolt" className="size-4 text-lime" />
            </div>
            <Button
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="gap-1.5"
            >
              <UploadCloud className="size-4" />
              {uploading ? 'Uploading...' : 'Upload Files'}
            </Button>
          </div>

          {/* Drag and Drop Zone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              if (e.dataTransfer.files) handleUploadFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              'border-2 border-dashed p-6 text-center cursor-pointer transition-all',
              isDragging
                ? 'border-lime bg-lime/10 scale-[1.01]'
                : 'border-ink/30 bg-card hover:border-ink hover:bg-paper-raised'
            )}
          >
            <UploadCloud className="mx-auto size-8 text-ink-faint mb-2" />
            <p className="font-bold text-sm text-ink">Drop files here or click to browse</p>
            <p className="font-mono text-xs text-ink-faint mt-1">
              Files up to 10 MiB · documents, images, spreadsheets, and archives linked to {model} #
              {recordId}
            </p>
          </div>

          {/* Attachments List */}
          {attachmentsLoading ? (
            <div className="space-y-2">
              <div className="h-12 border-2 border-ink/20 bg-card/60 animate-pulse" />
              <div className="h-12 border-2 border-ink/20 bg-card/60 animate-pulse" />
            </div>
          ) : attachments.length === 0 ? (
            <div className="border-2 border-dashed border-ink/30 bg-card/40 p-6 text-center font-mono text-xs text-ink-faint">
              No attachments stored for this record yet.
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {attachments.map((file) => {
                const FileIcon = getFileIcon(file.mimetype);
                return (
                  <div
                    key={file.id}
                    className="border-2 border-ink bg-card p-3 font-mono text-xs shadow-ink-sm flex items-start justify-between gap-2"
                  >
                    <div className="flex items-start gap-2.5 truncate">
                      <div className="size-8 border-2 border-ink bg-lime/20 flex items-center justify-center shrink-0">
                        <FileIcon className="size-4 text-ink" />
                      </div>
                      <div className="truncate space-y-0.5">
                        <p className="font-bold text-ink truncate" title={file.name}>
                          {file.name}
                        </p>
                        <p className="text-[10px] text-ink-faint">
                          {formatBytes(file.size_bytes)} ·{' '}
                          {file.mimetype.split('/')[1] || file.mimetype}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDownloadAttachment(file)}
                        className="size-7 text-ink-faint hover:text-lime hover:bg-lime/10"
                        title="Download attachment"
                      >
                        <Download className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteAttachment(file.id)}
                        className="size-7 text-ink-faint hover:text-pink hover:bg-pink/10"
                        title="Delete attachment"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 3. Audit Log Tab */}
      {activeTab === 'audit' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="font-display text-lg uppercase tracking-wide">
                Audit Trail & Change History
              </h3>
              <Doodle kind="crown" className="size-4 text-lime" />
            </div>
            <span className="font-mono text-[11px] text-ink-faint uppercase">
              Append-Only Security Ledger
            </span>
          </div>

          {!isAdmin ? (
            <div className="border-2 border-dashed border-ink/30 bg-card/40 p-6 text-center space-y-2">
              <UserCheck className="mx-auto size-7 text-ink-faint" />
              <p className="font-bold text-sm">Restricted Access</p>
              <p className="text-xs text-ink-faint max-w-sm mx-auto">
                Detailed field-level audit trails and actor security diffs are exclusively visible
                to system administrators.
              </p>
            </div>
          ) : auditLoading ? (
            <div className="space-y-2">
              <div className="h-14 border-2 border-ink/20 bg-card/60 animate-pulse" />
              <div className="h-14 border-2 border-ink/20 bg-card/60 animate-pulse" />
            </div>
          ) : !auditData?.records || auditData.records.length === 0 ? (
            <div className="border-2 border-dashed border-ink/30 bg-card/40 p-6 text-center">
              <p className="text-xs text-ink-faint">
                No audit entries recorded yet for this record.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {auditData.records.map((entry) => {
                let parsedChanges: Record<string, { before: unknown; after: unknown }> | null =
                  null;
                if (entry.changes) {
                  try {
                    parsedChanges = JSON.parse(entry.changes);
                  } catch {
                    // Raw string
                  }
                }

                return (
                  <div
                    key={entry.id}
                    className="border-2 border-ink bg-card p-3 font-mono text-xs shadow-ink-sm space-y-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink/20 pb-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'border px-1.5 py-0.5 font-bold uppercase text-[10px]',
                            entry.operation === 'create'
                              ? 'border-lime bg-lime text-on-accent'
                              : entry.operation === 'write'
                                ? 'border-ink bg-ink text-paper'
                                : 'border-pink bg-pink text-on-pink'
                          )}
                        >
                          {entry.operation}
                        </span>
                        <span className="font-bold text-ink">
                          Actor #{entry.actor_id ?? 'system'}
                        </span>
                      </div>
                      <span className="text-[10px] text-ink-faint">
                        {entry.create_date
                          ? formatDateTime(String(entry.create_date))
                          : `#${entry.id}`}
                      </span>
                    </div>

                    {parsedChanges && Object.keys(parsedChanges).length > 0 ? (
                      <div className="space-y-1 pt-1">
                        {Object.entries(parsedChanges).map(([field, delta]) => (
                          <div
                            key={field}
                            className="flex flex-wrap items-center gap-2 text-[11px]"
                          >
                            <span className="font-bold text-ink-soft">{field}:</span>
                            <span className="line-through text-pink/80">
                              {delta.before === null || delta.before === undefined
                                ? 'null'
                                : String(delta.before)}
                            </span>
                            <span className="text-ink-faint">→</span>
                            <span className="font-bold text-lime-600 dark:text-lime">
                              {delta.after === null || delta.after === undefined
                                ? 'null'
                                : String(delta.after)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-ink-faint truncate">
                        {entry.changes || 'No field modifications logged'}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
