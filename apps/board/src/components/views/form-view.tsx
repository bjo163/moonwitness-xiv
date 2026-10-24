import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArchiveIcon,
  ArrowRightIcon,
  BoltIcon,
  CheckIcon,
  DeleteIcon,
  SaveIcon,
} from '@moonwitness/ui/icons';
import { LoadingSpinner } from '@moonwitness/ui/components/effects';
import { evalDomain, type FieldMeta, type ResolvedViews } from '@moonwitness/client';
import { useRecord, useRecordMutations } from '@/hooks/use-model';
import { formatDateTime } from '@/lib/date-format';
import { Button } from '@moonwitness/ui/components/button';
import { Label } from '@moonwitness/ui/components/label';
import { Skeleton } from '@moonwitness/ui/components/skeleton';
import { FieldWidget } from './fields';
import { relationKey } from './field-utils';
import { One2ManyWidget } from './one2many-widget';
import { Chatter } from './chatter';
import { TagsWidget } from './tags-widget';
import { WorkflowPanel } from './workflow-panel';

interface FormViewProps {
  model: string;
  views: ResolvedViews;
  recordId?: number; // undefined = create mode
  initialValues?: Record<string, unknown>;
  onBack: () => void;
  onSaved?: (id: number) => void;
}

export function FormView(props: FormViewProps) {
  const { data: initialRecord, isLoading } = useRecord(props.model, props.recordId);
  if (props.recordId !== undefined && isLoading) {
    return (
      <div className="ink-panel p-8 space-y-6 bg-card">
        <Skeleton className="h-10 w-full bg-ink/10" />
        <Skeleton className="h-10 w-full bg-ink/10" />
        <Skeleton className="h-10 w-2/3 bg-ink/10" />
      </div>
    );
  }
  return (
    <FormEditor
      key={`${props.model}:${props.recordId ?? 'new'}:${JSON.stringify(props.initialValues ?? {})}`}
      {...props}
      initialRecord={initialRecord}
    />
  );
}

function FormEditor({
  model,
  views,
  recordId,
  initialValues,
  onBack,
  onSaved,
  initialRecord,
}: FormViewProps & { initialRecord?: Record<string, unknown> }) {
  const isCreate = recordId === undefined;
  const mutations = useRecordMutations(model);

  const [formData, setFormData] = useState<Record<string, unknown>>(() => {
    if (initialRecord) return { ...initialRecord };
    return {
      ...Object.fromEntries(
        views.fields
          .filter((field) => field.default !== undefined)
          .map((field) => [field.name, field.default])
      ),
      ...initialValues,
    };
  });
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const saveInFlight = useRef(false);

  // Field lookup map
  const fieldMap = useMemo(() => {
    return new Map<string, FieldMeta>(views.fields.map((f) => [f.name, f]));
  }, [views]);

  // Warn on browser tab close or reload if dirty
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirty]);

  const handleBackSafe = useCallback(() => {
    if (dirty && !window.confirm('You have unsaved changes. Are you sure you want to leave?')) {
      return;
    }
    onBack();
  }, [dirty, onBack]);

  function handleChange(name: string, val: unknown) {
    setFormData((prev) => {
      const next = { ...prev, [name]: val };
      // When country changes, reset dependent state field if it was set
      if (name === 'country' || name === 'country_id') {
        if (prev.state || prev.state_id) {
          next.state = null;
          next.state_id = null;
        }
      }
      return next;
    });
    setDirty(true);
    setError(null);
    setSuccessMsg(null);
  }

  const handleSave = useCallback(
    async (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      if (saveInFlight.current) return;
      setError(null);
      setSuccessMsg(null);

      // Validate required fields (respecting dynamic visibility and required predicates)
      for (const [name, f] of fieldMap.entries()) {
        if (f.type === 'one2many') continue;
        const isInvisible = evalDomain(f.invisible, formData);
        const isRequired = f.required || evalDomain(f.requiredIf, formData);

        if (
          !isInvisible &&
          isRequired &&
          (formData[name] === undefined || formData[name] === null || formData[name] === '')
        ) {
          setError(`Field '${f.label}' is required.`);
          return;
        }
      }

      try {
        const cleanValues: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(formData)) {
          if (['id', 'create_date', 'write_date', 'create_uid', 'write_uid'].includes(key))
            continue;
          const field = fieldMap.get(key);
          if (field && (field.readonly || field.type === 'one2many')) continue;
          if (typeof val === 'object' && val !== null && !Array.isArray(val) && !field) continue;
          cleanValues[key] = val;
        }
        for (const field of views.fields) {
          if (
            field.default !== undefined &&
            !Object.hasOwn(cleanValues, field.name) &&
            !field.readonly &&
            field.type !== 'one2many'
          ) {
            cleanValues[field.name] = field.default;
          }
        }

        saveInFlight.current = true;
        const saved = await mutations.save.mutateAsync({
          id: recordId,
          values: cleanValues,
        });
        setDirty(false);
        setSuccessMsg('Record saved successfully!');
        setTimeout(() => setSuccessMsg(null), 3500);

        if (isCreate && saved?.id) {
          onSaved?.(saved.id);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to save record.');
      } finally {
        saveInFlight.current = false;
      }
    },
    [fieldMap, formData, views.fields, mutations.save, recordId, isCreate, onSaved]
  );

  // Keyboard shortcut listener: Ctrl+S to save, Esc to go back
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 's' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSave();
      }
      if (e.key === 'Escape') {
        handleBackSafe();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave, handleBackSafe]);

  async function handleArchive(hard = false) {
    if (!recordId) return;
    const confirmMsg = hard
      ? 'Permanently delete this record? This action cannot be undone.'
      : 'Archive this record?';
    if (!window.confirm(confirmMsg)) return;

    try {
      await mutations.archive.mutateAsync({ id: recordId, hard });
      onBack();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to archive record.');
    }
  }

  const exposedActions = useMemo(() => {
    return (views.actions ?? []).filter((act) => act !== 'action_archive');
  }, [views.actions]);

  async function handleExecuteAction(method: string) {
    if (!recordId) return;
    setError(null);
    setSuccessMsg(null);
    try {
      await mutations.action.mutateAsync({ id: recordId, method });
      setSuccessMsg(`Action executed successfully.`);
      setTimeout(() => setSuccessMsg(null), 3500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed to execute.');
    }
  }

  const sections = views.form?.sections?.length
    ? views.form.sections
    : [{ fields: views.fields.map((f) => f.name) }];
  const canWrite = views.permissions.write || (isCreate && views.permissions.create);

  return (
    <div className="min-w-0 space-y-6">
      {/* Top action bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b-2 border-ink pb-5">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={handleBackSafe} className="gap-1.5">
            <ArrowRightIcon className="size-4 rotate-180" /> Back to list
          </Button>
          <div className="h-6 w-0.5 bg-ink/20" />
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="ink-title text-2xl sm:text-3xl">
              {isCreate ? (
                <span>New {views.title.replace(/s$/, '')}</span>
              ) : (
                <span>
                  {views.title.replace(/s$/, '')}{' '}
                  <span className="font-mono text-ink-faint">#{recordId}</span>
                </span>
              )}
            </h1>
            {!isCreate && recordId !== undefined && (
              <TagsWidget model={model} recordId={recordId} />
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Custom exposed actions */}
          {!isCreate &&
            exposedActions.map((method) => {
              if (method === 'action_unarchive' && initialRecord?.active !== false) {
                return null;
              }
              const label = method
                .replace(/^action_/, '')
                .replace(/_/g, ' ')
                .replace(/\b\w/g, (c) => c.toUpperCase());
              const isUnarchive = method === 'action_unarchive';

              return (
                <Button
                  key={method}
                  variant="outline"
                  size="sm"
                  onClick={() => handleExecuteAction(method)}
                  disabled={mutations.action.isPending}
                  className={
                    isUnarchive
                      ? 'gap-1.5 hover:bg-lime hover:text-on-accent'
                      : 'gap-1.5 hover:bg-lime/25'
                  }
                >
                  {mutations.action.isPending ? (
                    <LoadingSpinner className="size-4" />
                  ) : (
                    <BoltIcon className="size-4 text-lime-600 dark:text-lime" />
                  )}
                  {label}
                </Button>
              );
            })}

          {!isCreate && views.permissions.unlink && initialRecord?.active !== false && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleArchive(false)}
              className="gap-1.5 hover:bg-pink hover:text-on-pink"
              disabled={mutations.archive.isPending}
            >
              <ArchiveIcon className="size-4" /> Archive
            </Button>
          )}

          {!isCreate && views.permissions.unlink && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => handleArchive(true)}
              className="gap-1.5"
              disabled={mutations.archive.isPending}
              title="Permanently delete this record"
            >
              <DeleteIcon className="size-4" /> Delete permanently
            </Button>
          )}

          {canWrite && (
            <Button
              onClick={() => handleSave()}
              size="sm"
              disabled={!dirty || mutations.save.isPending}
              className="gap-1.5"
            >
              {mutations.save.isPending ? (
                <LoadingSpinner className="size-4" />
              ) : (
                <SaveIcon className="size-4" />
              )}
              Save Record
            </Button>
          )}
        </div>
      </div>

      {/* Notifications */}
      {error && (
        <div className="border-2 border-ink bg-pink p-3 font-bold text-on-pink shadow-ink">
          {error}
        </div>
      )}
      {successMsg && (
        <div className="border-2 border-ink bg-lime p-3 font-bold text-on-accent shadow-ink flex items-center gap-2">
          <CheckIcon className="size-5" /> {successMsg}
        </div>
      )}

      {!isCreate && recordId !== undefined && <WorkflowPanel model={model} recordId={recordId} />}

      {/* Form sections */}
      <form onSubmit={handleSave} className="space-y-6">
        {sections.map((section, sIdx) => {
          const visibleFields = section.fields
            .map((fieldName) => fieldMap.get(fieldName))
            .filter((f): f is FieldMeta => f !== undefined && f.name !== 'id');

          return (
            <div key={sIdx} className="ink-panel min-w-0 bg-card p-6 sm:p-8">
              {section.title && (
                <div className="mb-6 border-b-2 border-ink pb-2">
                  <h2 className="font-display text-xl uppercase tracking-wider">{section.title}</h2>
                </div>
              )}

              <div className="grid min-w-0 gap-6 sm:grid-cols-2">
                {visibleFields.map((field) => {
                  const isInvisible = evalDomain(field.invisible, formData);
                  if (isInvisible) return null;

                  const isReadonly = field.readonly || evalDomain(field.readonlyIf, formData);
                  const isRequired = field.required || evalDomain(field.requiredIf, formData);

                  if (field.type === 'one2many') {
                    return (
                      <div key={field.name} className="min-w-0 pt-2 sm:col-span-2">
                        <One2ManyWidget
                          field={field}
                          parentModel={model}
                          parentId={recordId}
                          isCreate={isCreate}
                        />
                      </div>
                    );
                  }

                  const isFullWidth = field.type === 'string' && field.name.includes('description');
                  const relatedObj = initialRecord?.[relationKey(field)] as Record<
                    string,
                    unknown
                  > | null;

                  const effectiveField: FieldMeta = {
                    ...field,
                    readonly: isReadonly,
                    required: isRequired,
                  };

                  const contextDomain = (() => {
                    if (field.name === 'state' || field.name === 'state_id') {
                      const countryVal = formData.country_id ?? formData.country;
                      if (countryVal) {
                        return [['country_id', '=', countryVal]] as Array<
                          [string, string, unknown]
                        >;
                      }
                    }
                    if (field.name === 'bank' || field.name === 'bank_id') {
                      const countryVal = formData.country_id ?? formData.country;
                      if (countryVal) {
                        return [['country_id', '=', countryVal]] as Array<
                          [string, string, unknown]
                        >;
                      }
                    }
                    return undefined;
                  })();

                  return (
                    <div
                      key={field.name}
                      className={isFullWidth ? 'sm:col-span-2 space-y-2' : 'space-y-2'}
                    >
                      <div className="flex items-center justify-between">
                        <Label
                          htmlFor={`field-${field.name}`}
                          className="font-bold text-xs uppercase tracking-wider"
                        >
                          {field.label}
                          {isRequired && <span className="ml-1 text-pink">*</span>}
                        </Label>
                        {isReadonly && (
                          <span className="font-mono text-[10px] uppercase text-ink-faint">
                            Readonly
                          </span>
                        )}
                      </div>

                      <FieldWidget
                        id={`field-${field.name}`}
                        field={effectiveField}
                        value={formData[field.name] ?? field.default}
                        onChange={(val) => handleChange(field.name, val)}
                        related={relatedObj}
                        contextDomain={contextDomain}
                      />

                      {field.help && <p className="text-xs text-ink-faint">{field.help}</p>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </form>

      {/* Audit Trail & Meta box */}
      {!isCreate && initialRecord && (
        <div className="ink-panel border-dashed bg-card/60 p-4 text-xs font-mono text-ink-muted">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-6">
              <div>
                <span className="block text-[10px] uppercase tracking-wider text-ink-faint">
                  Created At
                </span>
                <span>
                  {initialRecord.create_date
                    ? formatDateTime(String(initialRecord.create_date))
                    : '—'}
                </span>
              </div>
              <div>
                <span className="block text-[10px] uppercase tracking-wider text-ink-faint">
                  Last Modified
                </span>
                <span>
                  {initialRecord.write_date
                    ? formatDateTime(String(initialRecord.write_date))
                    : '—'}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="ink-tag text-[10px]">
                Status: {initialRecord.active !== false ? 'ACTIVE' : 'ARCHIVED'}
              </span>
              <span className="font-mono text-[10px] text-ink-faint">ID: #{recordId}</span>
            </div>
          </div>
        </div>
      )}

      {/* Unified Chatter & Activity Stream */}
      {!isCreate && recordId !== undefined && <Chatter model={model} recordId={recordId} />}
    </div>
  );
}
