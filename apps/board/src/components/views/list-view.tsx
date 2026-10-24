import {
  Table as UiTable,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
} from '@moonwitness/ui/components/table';
import { Checkbox } from '@moonwitness/ui/components/checkbox';
import { SelectField } from '@moonwitness/ui/components/select-field';
import { Button } from '@moonwitness/ui/components/button';
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArchiveIcon,
  AddIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  CloseIcon,
  ColumnsIcon,
  DownloadIcon,
  FilterIcon,
  GridIcon,
  ModelIcon,
  SearchIcon,
  SortAscendingIcon,
  SortDescendingIcon,
  SortIcon,
  TagIcon,
  UploadIcon,
} from '@moonwitness/ui/icons';
import { LoadingSpinner } from '@moonwitness/ui/components/effects';
import type { Domain, ResolvedViews } from '@moonwitness/client';
import { client } from '@/lib/client';
import { formatDateTime } from '@/lib/date-format';
import { serializeCsv } from '@/lib/csv-export';
import { scopedQueryKey } from '@/lib/query-scope';
import { useRecordMutations, useRecords } from '@/hooks/use-model';
import { Input } from '@moonwitness/ui/components/input';
import { Skeleton } from '@moonwitness/ui/components/skeleton';
import { Popover, PopoverContent, PopoverTrigger } from '@moonwitness/ui/components/popover';
import { AccentMarker, Doodle, SpeedLines } from '@moonwitness/ui/components/effects';
import { cn } from '@/lib/utils';
import { FieldCell } from './fields';
import { relationKey } from './field-utils';
import { ImportWizardDialog } from './import-wizard-dialog';
import { QueryBuilderDialog, type FilterRule } from './query-builder-dialog';

interface CustomFilter {
  id: string;
  field: string;
  fieldLabel: string;
  operator: '=' | '!=' | 'ilike' | '>' | '<';
  value: string;
}

interface ListViewProps {
  model: string;
  views: ResolvedViews;
  onOpenRecord: (id: number) => void;
  onCreateRecord: () => void;
}

function toSingular(title: string): string {
  if (title.endsWith('ies')) {
    return title.slice(0, -3) + 'y';
  }
  if (title.endsWith('ses')) {
    return title.slice(0, -2);
  }
  if (title.endsWith('s') && !title.endsWith('ss')) {
    return title.slice(0, -1);
  }
  return title;
}

export function ListView({ model, views, onOpenRecord, onCreateRecord }: ListViewProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilterIndex, setActiveFilterIndex] = useState<number | null>(0); // Default to first filter if available
  const [viewMode, setViewMode] = useState<'table' | 'grid' | 'pipeline'>('table');
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const queryClient = useQueryClient();

  // Custom visual filter builder state
  const [customFilters, setCustomFilters] = useState<CustomFilter[]>([]);
  const [filterBuilderOpen, setFilterBuilderOpen] = useState(false);
  const [builderField, setBuilderField] = useState(views.fields[0]?.name ?? '');
  const [builderOp, setBuilderOp] = useState<'=' | '!=' | 'ilike' | '>' | '<'>('ilike');
  const [builderVal, setBuilderVal] = useState('');

  // Universal Import Wizard state
  const [importWizardOpen, setImportWizardOpen] = useState(false);

  // Advanced Query Builder state
  const [queryBuilderOpen, setQueryBuilderOpen] = useState(false);
  const [advancedRules, setAdvancedRules] = useState<FilterRule[]>([]);
  const [advancedConjunction, setAdvancedConjunction] = useState<'all' | 'any'>('all');

  // Sorting state: initialized from views.list.order if present
  const [sortState, setSortState] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(() => {
    if (views.list.order) {
      const parts = views.list.order.trim().split(/\s+/);
      if (parts[0]) {
        return { col: parts[0], dir: (parts[1]?.toLowerCase() as 'asc' | 'desc') || 'asc' };
      }
    }
    return null;
  });

  const handleSort = (colName: string) => {
    setSortState((prev) => {
      if (prev?.col === colName) {
        if (prev.dir === 'asc') return { col: colName, dir: 'desc' };
        return null; // Return to default
      }
      return { col: colName, dir: 'asc' };
    });
    setPage(1);
  };

  // Build filters: views.search.filters + custom ones like Active/Archived
  const filters = useMemo(() => {
    const list = [...(views.search?.filters ?? [])];
    const hasActiveField = views.fields.some((f) => f.name === 'active');
    if (hasActiveField && !list.some((f) => f.label.toLowerCase() === 'active')) {
      list.unshift(
        { label: 'Active', domain: [['active', '=', true]] },
        { label: 'Archived', domain: [['active', '=', false]] }
      );
    }
    return list;
  }, [views]);

  // Build combined domain
  const domain = useMemo<Domain>(() => {
    const terms: Domain = [];
    if (activeFilterIndex !== null && filters[activeFilterIndex]) {
      terms.push(...filters[activeFilterIndex].domain);
    }
    // Apply custom visual filters
    for (const cf of customFilters) {
      if (cf.operator === 'ilike') {
        terms.push([cf.field, 'ilike', `%${cf.value}%`]);
      } else if (cf.operator === '=' || cf.operator === '!=') {
        let val: unknown = cf.value;
        if (cf.value === 'true') val = true;
        else if (cf.value === 'false') val = false;
        else if (cf.value === 'null') val = null;
        else if (/^\d+$/.test(cf.value)) val = Number(cf.value);
        terms.push([cf.field, cf.operator, val]);
      } else {
        const numVal = Number(cf.value);
        terms.push([cf.field, cf.operator, isNaN(numVal) ? cf.value : numVal]);
      }
    }
    // Apply Advanced Query Builder rules
    if (advancedRules.length > 0) {
      const advClauses: [string, string, unknown][] = [];
      for (const ar of advancedRules) {
        if (ar.operator === 'is_set') {
          advClauses.push([ar.field, '!=', null]);
        } else if (ar.operator === 'is_null') {
          advClauses.push([ar.field, '=', null]);
        } else if (ar.operator === 'ilike') {
          advClauses.push([ar.field, 'ilike', `%${ar.value}%`]);
        } else if (ar.operator === '=' || ar.operator === '!=') {
          let val: unknown = ar.value;
          if (ar.value === 'true') val = true;
          else if (ar.value === 'false') val = false;
          else if (ar.value === 'null') val = null;
          else if (/^\d+$/.test(ar.value)) val = Number(ar.value);
          advClauses.push([ar.field, ar.operator, val]);
        } else {
          const numVal = Number(ar.value);
          advClauses.push([ar.field, ar.operator, isNaN(numVal) ? ar.value : numVal]);
        }
      }

      if (advClauses.length === 1 || advancedConjunction === 'all') {
        terms.push(...advClauses);
      } else {
        // Polish notation prefix '|' for ANY (OR)
        for (let i = 0; i < advClauses.length - 1; i++) {
          terms.push('|');
        }
        terms.push(...advClauses);
      }
    }

    if (searchTerm.trim()) {
      const searchFields = views.search?.fields?.length
        ? views.search.fields
        : views.fields
            .filter((f) => f.type === 'string')
            .map((f) => f.name)
            .slice(0, 3);

      if (searchFields.length > 0) {
        // Build OR domain for matching searchFields: ['|', [f1, 'ilike', term], [f2, ...]]
        const orClauses = searchFields.map(
          (f) => [f, 'ilike', `%${searchTerm.trim()}%`] as [string, string, unknown]
        );
        if (orClauses.length === 1) {
          terms.push(orClauses[0]);
        } else {
          // Polish notation prefix '|'
          for (let i = 0; i < orClauses.length - 1; i++) {
            terms.push('|');
          }
          terms.push(...orClauses);
        }
      }
    }
    return terms;
  }, [
    activeFilterIndex,
    filters,
    searchTerm,
    views,
    customFilters,
    advancedRules,
    advancedConjunction,
  ]);

  // Eager load belongsTo relations present in columns
  const withRelations = useMemo(() => {
    const many2oneFields = views.fields.filter(
      (f) => f.type === 'many2one' && views.list.columns.includes(f.name)
    );
    if (!many2oneFields.length) return undefined;
    return many2oneFields.map(relationKey).join(',');
  }, [views]);

  const currentOrder = sortState ? `${sortState.col} ${sortState.dir}` : views.list.order;

  const offset = (page - 1) * pageSize;
  const { data, isLoading, isFetching, isPlaceholderData, isError, refetch } = useRecords(model, {
    domain,
    offset,
    limit: pageSize,
    order: currentOrder,
    with: withRelations,
  });

  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const columns = useMemo(() => {
    return views.list.columns
      .map((colName) => views.fields.find((f) => f.name === colName))
      .filter((f): f is NonNullable<typeof f> => Boolean(f))
      .filter((field) => !field.writeOnly);
  }, [views]);

  const mutations = useRecordMutations(model);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [isBulkArchiving, setIsBulkArchiving] = useState(false);

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  };

  const handleSelectAllCurrentPage = (checked: boolean) => {
    if (!data?.records) return;
    const pageIds = data.records.map((r) => r.id as number);
    if (checked) {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...pageIds])));
    } else {
      setSelectedIds((prev) => prev.filter((id) => !pageIds.includes(id)));
    }
  };

  const areAllOnPageSelected = useMemo(() => {
    if (!data?.records.length) return false;
    return data.records.every((r) => selectedIds.includes(r.id as number));
  }, [data, selectedIds]);

  const areSomeOnPageSelected = useMemo(() => {
    if (!data?.records.length) return false;
    return data.records.some((r) => selectedIds.includes(r.id as number)) && !areAllOnPageSelected;
  }, [data, selectedIds, areAllOnPageSelected]);

  const handleBulkArchive = async () => {
    if (!selectedIds.length) return;
    if (
      !window.confirm(`Are you sure you want to archive ${selectedIds.length} selected record(s)?`)
    ) {
      return;
    }

    setIsBulkArchiving(true);
    try {
      await Promise.all(
        selectedIds.map((id) => mutations.archive.mutateAsync({ id, hard: false }))
      );
      setSelectedIds([]);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to archive selected records');
    } finally {
      setIsBulkArchiving(false);
    }
  };

  // Pipeline Kanban Candidate Grouping Field
  const groupingField = useMemo(() => {
    return (
      views.fields.find((f) => ['state', 'status', 'stage', 'activity_type'].includes(f.name)) ||
      views.fields.find((f) => f.type === 'selection' || f.name.endsWith('_type')) ||
      views.fields.find((f) => f.name === 'active') ||
      null
    );
  }, [views.fields]);

  // Unique stages extracted from field selection metadata, defaults, or dataset
  const pipelineStages = useMemo(() => {
    if (!groupingField) return [];
    const stages: string[] = [];

    // Priority 1: predefined selection/enum values from schema
    if (groupingField.selection && groupingField.selection.length > 0) {
      for (const item of groupingField.selection) {
        if (!stages.includes(item.value)) {
          stages.push(item.value);
        }
      }
    } else if (groupingField.type === 'boolean') {
      stages.push('true', 'false');
    } else if (groupingField.name === 'state') {
      stages.push('planned', 'done', 'cancelled');
    }

    // Merge any actual record values present on the page that might not be in selection
    if (data?.records) {
      for (const r of data.records) {
        const val = r[groupingField.name];
        if (val !== undefined && val !== null) {
          const strVal = String(val);
          if (!stages.includes(strVal)) {
            stages.push(strVal);
          }
        }
      }
    }

    return stages;
  }, [groupingField, data]);

  const handleMoveStage = async (recordId: number, newStage: string) => {
    if (!groupingField) return;
    let val: unknown = newStage;
    if (groupingField.type === 'boolean') {
      val = newStage === 'true';
    }
    await mutations.save.mutateAsync({
      id: recordId,
      values: { [groupingField.name]: val },
    });
  };

  // Mass Tagging State & Mutation
  const [tagPopoverOpen, setTagPopoverOpen] = useState(false);
  const [isMassTagging, setIsMassTagging] = useState(false);
  const { data: availableTagsData } = useQuery({
    queryKey: scopedQueryKey(['available_tags']),
    queryFn: () =>
      client
        .model<{ id: number; name: string; color: string }>('base.tag')
        .searchRead({ limit: 50, order: 'name asc' }),
  });
  const availableTags = availableTagsData?.records ?? [];

  const handleMassTag = async (tagId: number) => {
    if (selectedIds.length === 0) return;
    setIsMassTagging(true);
    try {
      await Promise.all(
        selectedIds.map(async (recordId) => {
          try {
            await client.model('base.tag_link').create({
              tag_id: tagId,
              resource_model: model,
              resource_id: recordId,
            });
          } catch (err: unknown) {
            // Ignore duplicate constraint if record is already tagged with this tag
            const msg = err instanceof Error ? err.message : String(err);
            const isConflict =
              (err as { status?: number })?.status === 409 ||
              msg.toLowerCase().includes('unique') ||
              msg.toLowerCase().includes('conflict');
            if (!isConflict) throw err;
          }
        })
      );
      queryClient.invalidateQueries({ queryKey: ['records', model] });
      queryClient.invalidateQueries({ queryKey: ['records', 'base.tag_link'] });
      setSelectedIds([]);
      setTagPopoverOpen(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to tag selected records');
    } finally {
      setIsMassTagging(false);
    }
  };

  const handleExportCsv = () => {
    if (!data?.records.length) return;
    const recordsToExport =
      selectedIds.length > 0
        ? data.records.filter((r) => selectedIds.includes(r.id as number))
        : data.records;
    const exportColumns = columns.filter((column) => !column.writeOnly);

    const headers = ['ID', ...exportColumns.map((c) => c.label)];
    const rows = recordsToExport.map((row) => [
      String(row.id),
      ...exportColumns.map((c) => {
        const val = row[c.name];
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') {
          return (val as { name?: string }).name ?? JSON.stringify(val);
        }
        return String(val);
      }),
    ]);

    const csvContent = serializeCsv(headers, rows);

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${model.replace(/\./g, '_')}_export_${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Title & Speed lines header */}
      <div className="relative flex flex-col justify-between gap-4 border-b-2 border-ink pb-6 sm:flex-row sm:items-end">
        <SpeedLines className="opacity-15" count={45} origin={[0.08, 0.4]} inner={0.2} />
        <div>
          <div className="flex items-center gap-3">
            <h1 className="ink-title text-4xl sm:text-5xl">
              <AccentMarker>{views.title}</AccentMarker>
            </h1>
            <Doodle kind="star" className="size-6 text-pink" />
          </div>
          <p className="mt-1 font-mono text-xs uppercase tracking-widest text-ink-faint">
            {total} total records · Model: {model}
          </p>
        </div>

        {views.permissions.create && (
          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              id="btn-import-records"
              variant="outline"
              size="lg"
              onClick={() => setImportWizardOpen(true)}
              className="press gap-2 shadow-ink-sm"
              title="Import records from CSV"
            >
              <UploadIcon className="size-5 text-lime" />
              <span className="font-display tracking-wider">Import CSV</span>
            </Button>
            <Button
              id="btn-create-record"
              onClick={onCreateRecord}
              size="lg"
              className="press gap-2 shadow-ink"
            >
              <AddIcon className="size-5" strokeWidth={3} />
              <span className="font-display tracking-wider">New {toSingular(views.title)}</span>
            </Button>
          </div>
        )}
      </div>

      {/* Control bar: Search, Sticker Filters, Dual View Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* Search Input */}
        <div className="relative w-full max-w-sm sm:w-80">
          <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
          <Input
            id="search-input"
            placeholder={`Search ${views.title.toLowerCase()}...`}
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              setPage(1);
            }}
            className="pl-9 pr-4"
          />
        </div>

        {/* Filters & View Switcher */}
        <div className="flex flex-wrap items-center gap-3">
          {filters.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 font-mono text-xs uppercase text-ink-faint mr-1">
                <FilterIcon className="size-3.5" /> Filters:
              </div>
              {filters.map((filter, idx) => {
                const active = activeFilterIndex === idx;
                return (
                  <Button
                    key={filter.label}
                    type="button"
                    data-active={active}
                    onClick={() => {
                      setActiveFilterIndex(active ? null : idx);
                      setPage(1);
                    }}
                    className="sticker text-xs"
                    style={{ '--tilt': `${(idx % 3) - 1.2}deg` } as React.CSSProperties}
                  >
                    {filter.label}
                  </Button>
                );
              })}

              {/* Active Custom Filter Stickers */}
              {customFilters.map((cf) => (
                <span
                  key={cf.id}
                  className="sticker text-xs border-2 border-ink bg-lime text-on-accent font-bold"
                >
                  <span>
                    {cf.fieldLabel} {cf.operator} &quot;{cf.value}&quot;
                  </span>
                  <Button
                    type="button"
                    onClick={() => setCustomFilters((prev) => prev.filter((f) => f.id !== cf.id))}
                    className="ml-1 hover:text-pink transition-colors"
                    title="Remove filter"
                  >
                    <CloseIcon className="size-3" />
                  </Button>
                </span>
              ))}

              {/* Add Custom Filter Popover */}
              <Popover open={filterBuilderOpen} onOpenChange={setFilterBuilderOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    className="inline-flex items-center gap-1 border-2 border-dashed border-ink/40 bg-card px-2 py-0.5 font-mono text-xs font-semibold text-ink-faint hover:border-ink hover:text-ink hover:bg-paper-raised transition-colors"
                  >
                    <AddIcon className="size-3" /> Filter
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-3 space-y-3 font-sans">
                  <div className="font-display text-xs uppercase tracking-wider text-ink border-b border-ink/20 pb-1.5 flex items-center justify-between">
                    <span>Add Custom Filter</span>
                    <FilterIcon className="size-3 text-lime" />
                  </div>

                  <div className="space-y-2 font-mono text-xs">
                    <div>
                      <span className="block text-[10px] uppercase text-ink-faint mb-1">Field</span>
                      <SelectField
                        value={builderField}
                        onChange={(e) => setBuilderField(e.target.value)}
                        className="w-full h-8 border-2 border-ink bg-paper px-2 text-xs text-ink outline-none"
                      >
                        {views.fields
                          .filter((f) => f.type !== 'one2many')
                          .map((f) => (
                            <option key={f.name} value={f.name}>
                              {f.label} ({f.name})
                            </option>
                          ))}
                      </SelectField>
                    </div>

                    <div>
                      <span className="block text-[10px] uppercase text-ink-faint mb-1">
                        Condition
                      </span>
                      <SelectField
                        value={builderOp}
                        onChange={(e) =>
                          setBuilderOp(e.target.value as '=' | '!=' | 'ilike' | '>' | '<')
                        }
                        className="w-full h-8 border-2 border-ink bg-paper px-2 text-xs text-ink outline-none"
                      >
                        <option value="ilike">contains</option>
                        <option value="=">equals</option>
                        <option value="!=">not equal</option>
                        <option value=">">greater than</option>
                        <option value="<">less than</option>
                      </SelectField>
                    </div>

                    <div>
                      <span className="block text-[10px] uppercase text-ink-faint mb-1">Value</span>
                      <Input
                        placeholder="Search value..."
                        value={builderVal}
                        onChange={(e) => setBuilderVal(e.target.value)}
                        className="h-8 text-xs border-2 border-ink"
                      />
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 pt-1">
                    <Button
                      size="xs"
                      disabled={!builderVal.trim()}
                      onClick={() => {
                        const targetMeta = views.fields.find((f) => f.name === builderField);
                        setCustomFilters((prev) => [
                          ...prev,
                          {
                            id: `cf_${Date.now()}`,
                            field: builderField,
                            fieldLabel: targetMeta?.label ?? builderField,
                            operator: builderOp,
                            value: builderVal.trim(),
                          },
                        ]);
                        setBuilderVal('');
                        setFilterBuilderOpen(false);
                        setPage(1);
                      }}
                    >
                      Apply Filter
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>

              {/* Active Advanced Filter Stickers */}
              {advancedRules.map((ar) => (
                <span
                  key={ar.id}
                  className="sticker text-xs border-2 border-ink bg-lime text-on-accent font-bold"
                >
                  <span>
                    {views.fields.find((f) => f.name === ar.field)?.label ?? ar.field} {ar.operator}{' '}
                    {ar.operator !== 'is_set' && ar.operator !== 'is_null' ? `"${ar.value}"` : ''}
                  </span>
                  <Button
                    type="button"
                    onClick={() => setAdvancedRules((prev) => prev.filter((r) => r.id !== ar.id))}
                    className="ml-1 hover:text-pink transition-colors"
                    title="Remove filter"
                  >
                    <CloseIcon className="size-3" />
                  </Button>
                </span>
              ))}

              {/* Advanced Query Builder Trigger Button */}
              <Button
                type="button"
                onClick={() => setQueryBuilderOpen(true)}
                className="inline-flex items-center gap-1 border-2 border-dashed border-ink/40 bg-card px-2 py-0.5 font-mono text-xs font-semibold text-ink-faint hover:border-ink hover:text-ink hover:bg-paper-raised transition-colors"
                title="Open Advanced Query Builder"
              >
                <FilterIcon className="size-3 text-lime" /> Advanced Query
                {advancedRules.length > 0 && (
                  <span className="ml-1 border border-ink bg-ink px-1 text-[10px] text-paper">
                    {advancedRules.length}
                  </span>
                )}
              </Button>

              {(customFilters.length > 0 || advancedRules.length > 0) && (
                <Button
                  type="button"
                  onClick={() => {
                    setCustomFilters([]);
                    setAdvancedRules([]);
                  }}
                  className="font-mono text-[10px] uppercase text-ink-faint hover:text-pink underline"
                >
                  Clear all
                </Button>
              )}
            </div>
          )}

          {/* Triple View Toggle: Table, Grid, Pipeline */}
          <div className="flex items-center border-2 border-ink bg-card p-0.5 shadow-ink-sm">
            <Button
              type="button"
              onClick={() => setViewMode('table')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase transition-all',
                viewMode === 'table'
                  ? 'border border-ink bg-lime text-on-accent shadow-[1.5px_1.5px_0_0_var(--ink)]'
                  : 'bg-card text-ink-soft hover:text-ink'
              )}
              title="Table View"
            >
              <ModelIcon className="size-3.5" />
              <span className="hidden sm:inline">Table</span>
            </Button>
            <Button
              type="button"
              onClick={() => setViewMode('grid')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase transition-all',
                viewMode === 'grid'
                  ? 'border border-ink bg-lime text-on-accent shadow-[1.5px_1.5px_0_0_var(--ink)]'
                  : 'bg-card text-ink-soft hover:text-ink'
              )}
              title="Cards Grid View"
            >
              <GridIcon className="size-3.5" />
              <span className="hidden sm:inline">Grid</span>
            </Button>
            <Button
              type="button"
              onClick={() => setViewMode('pipeline')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase transition-all',
                viewMode === 'pipeline'
                  ? 'border border-ink bg-lime text-on-accent shadow-[1.5px_1.5px_0_0_var(--ink)]'
                  : 'bg-card text-ink-soft hover:text-ink'
              )}
              title="Kanban Pipeline Stages"
            >
              <ColumnsIcon className="size-3.5" />
              <span className="hidden sm:inline">Pipeline</span>
            </Button>
          </div>
        </div>
      </div>

      {isError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 border-2 border-ink bg-pink p-3 font-bold text-on-pink shadow-ink"
        >
          <span>Could not load records. Check your connection and try again.</span>
          <Button
            variant="outline"
            size="sm"
            disabled={isFetching}
            onClick={() => void refetch()}
            className="border-paper text-on-pink hover:bg-white hover:text-ink"
          >
            {isFetching ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      )}

      {/* Main Content: Table, Grid, or Pipeline */}
      {viewMode === 'table' && (
        /* Manga Ink Table */
        <div className="ink-panel overflow-hidden bg-card">
          <div className="space-y-3 p-3 sm:hidden">
            {isLoading ? (
              Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="h-24 animate-pulse border-2 border-ink/10 bg-ink/5" />
              ))
            ) : data?.records.length === 0 ? (
              <div className="py-8 text-center">
                <Doodle kind="sparkle" className="mx-auto size-8 text-lime" />
                <p className="mt-2 font-display text-lg uppercase">No records found</p>
                <p className="text-sm text-ink-soft">
                  {searchTerm
                    ? 'Try adjusting your search or active filter stickers.'
                    : 'Be the first to create one!'}
                </p>
              </div>
            ) : (
              data?.records.map((row) => {
                const titleField = columns.find(
                  (field) =>
                    field.name === 'name' ||
                    field.name === 'login' ||
                    field.name === 'summary' ||
                    field.name === 'code' ||
                    field.type === 'string'
                );
                const titleValue = titleField ? String(row[titleField.name] ?? '') : `#${row.id}`;
                const detailFields = columns
                  .filter((field) => field.name !== titleField?.name)
                  .slice(0, 4);
                const selected = selectedIds.includes(row.id as number);

                return (
                  <article
                    key={row.id}
                    onClick={() => onOpenRecord(row.id)}
                    className={cn(
                      'ink-panel cursor-pointer border-2 border-ink p-3',
                      selected ? 'bg-lime/10' : 'bg-card'
                    )}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-2">
                        <Checkbox
                          aria-label={`Select record #${row.id}`}
                          checked={selected}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggleSelect(row.id as number)}
                          className="mt-1 size-4 shrink-0 cursor-pointer accent-lime"
                        />
                        <div className="min-w-0">
                          <h2 className="break-words font-display text-lg uppercase leading-tight text-ink">
                            {titleValue || `#${row.id}`}
                          </h2>
                          <p className="mt-1 font-mono text-[10px] uppercase text-ink-faint">
                            #{row.id}
                          </p>
                        </div>
                      </div>
                      {row.active !== undefined && (
                        <span className="shrink-0 border border-ink/30 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase">
                          {row.active !== false ? 'Active' : 'Archived'}
                        </span>
                      )}
                    </div>
                    {detailFields.length > 0 && (
                      <dl className="mt-3 space-y-2 border-t border-dashed border-ink/20 pt-3">
                        {detailFields.map((field) => (
                          <div
                            key={field.name}
                            className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] gap-2 text-xs"
                          >
                            <dt className="truncate font-mono text-[10px] uppercase text-ink-faint">
                              {field.label}
                            </dt>
                            <dd className="min-w-0 truncate text-right text-ink">
                              <FieldCell field={field} row={row} />
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    <div className="mt-3 flex justify-end border-t border-ink/10 pt-2">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenRecord(row.id);
                        }}
                      >
                        Open →
                      </Button>
                    </div>
                  </article>
                );
              })
            )}
          </div>
          <div
            className="overflow-x-auto [&>.mw-ui-table-wrap]:overflow-x-visible"
            role="region"
            aria-label={`${views.title} records table`}
            tabIndex={0}
          >
            <UiTable className="hidden w-full min-w-[1200px] border-collapse text-left text-sm sm:table">
              <TableHead>
                <TableRow className="border-b-2 border-ink bg-paper font-display uppercase tracking-wider text-ink">
                  <TableHeader className="w-10 px-4 py-3 text-center">
                    <Checkbox
                      aria-label="Select all records on current page"
                      checked={areAllOnPageSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = areSomeOnPageSelected;
                      }}
                      onChange={(e) => handleSelectAllCurrentPage(e.target.checked)}
                      className="size-4 cursor-pointer accent-lime border-2 border-ink rounded-none bg-paper"
                    />
                  </TableHeader>
                  {columns.map((col) => {
                    const isSorted = sortState?.col === col.name;
                    return (
                      <TableHeader
                        key={col.name}
                        onClick={() => handleSort(col.name)}
                        className="cursor-pointer select-none px-4 py-3 text-xs transition-colors hover:bg-lime/25"
                        title={`Click to sort by ${col.label}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span>{col.label}</span>
                          {isSorted ? (
                            sortState.dir === 'asc' ? (
                              <SortAscendingIcon
                                className="size-3.5 text-lime-600 dark:text-lime"
                                strokeWidth={3}
                              />
                            ) : (
                              <SortDescendingIcon
                                className="size-3.5 text-lime-600 dark:text-lime"
                                strokeWidth={3}
                              />
                            )
                          ) : (
                            <SortIcon className="size-3 text-ink-faint opacity-30 hover:opacity-100" />
                          )}
                        </div>
                      </TableHeader>
                    );
                  })}
                  <TableHeader className="px-4 py-3 text-right text-xs">Action</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody className="divide-y-2 divide-ink/10 font-sans">
                {isLoading ? (
                  Array.from({ length: 5 }, (_, i) => (
                    <TableRow key={i}>
                      <TableCell className="w-10 px-4 py-3.5 text-center">
                        <Skeleton className="mx-auto size-4 bg-ink/10" />
                      </TableCell>
                      {columns.map((col) => (
                        <TableCell key={col.name} className="px-4 py-3.5">
                          <Skeleton className="h-5 w-24 bg-ink/10" />
                        </TableCell>
                      ))}
                      <TableCell className="px-4 py-3.5 text-right">
                        <Skeleton className="ml-auto h-5 w-12 bg-ink/10" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : data?.records.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length + 2} className="py-16 text-center">
                      <div className="mx-auto max-w-sm space-y-3">
                        <Doodle kind="sparkle" className="mx-auto size-8 text-lime" />
                        <p className="font-display text-xl uppercase">No records found</p>
                        <p className="text-sm text-ink-soft">
                          {searchTerm
                            ? 'Try adjusting your search or active filter stickers.'
                            : 'Be the first to create one!'}
                        </p>
                        {views.permissions.create && (
                          <Button
                            onClick={onCreateRecord}
                            variant="outline"
                            size="sm"
                            className="mt-2"
                          >
                            <AddIcon className="size-4" /> Create Record
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.records.map((row) => (
                    <TableRow
                      key={row.id}
                      onClick={() => onOpenRecord(row.id)}
                      className="cursor-pointer transition-colors hover:bg-lime/25"
                    >
                      <TableCell
                        className="w-10 px-4 py-3.5 text-center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          aria-label={`Select record #${row.id}`}
                          checked={selectedIds.includes(row.id as number)}
                          onChange={() => toggleSelect(row.id as number)}
                          className="size-4 cursor-pointer accent-lime border-2 border-ink rounded-none bg-paper"
                        />
                      </TableCell>
                      {columns.map((col) => (
                        <TableCell key={col.name} className="px-4 py-3.5 text-ink">
                          <FieldCell field={col} row={row} />
                        </TableCell>
                      ))}
                      <TableCell className="px-4 py-3.5 text-right">
                        <Button
                          variant="ghost"
                          size="xs"
                          className="font-mono text-xs hover:bg-ink hover:text-paper"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenRecord(row.id);
                          }}
                        >
                          Open →
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </UiTable>
          </div>
        </div>
      )}

      {/* 2. Manga Ink Cards Grid View */}
      {viewMode === 'grid' && (
        <div className="space-y-4">
          {isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="h-44 border-2 border-ink/20 bg-card p-4 animate-pulse" />
              ))}
            </div>
          ) : data?.records.length === 0 ? (
            <div className="ink-panel border-2 border-dashed bg-card/40 p-16 text-center">
              <Doodle kind="sparkle" className="mx-auto size-8 text-lime" />
              <p className="font-display text-xl uppercase mt-2">No records found</p>
              <p className="text-sm text-ink-soft">
                {searchTerm
                  ? 'Try adjusting your search or active filter stickers.'
                  : 'Be the first to create one!'}
              </p>
              {views.permissions.create && (
                <Button onClick={onCreateRecord} variant="outline" size="sm" className="mt-3">
                  <AddIcon className="size-4" /> Create Record
                </Button>
              )}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {data?.records.map((row) => {
                const isSelected = selectedIds.includes(row.id as number);
                const titleField = columns.find(
                  (c) =>
                    c.name === 'name' ||
                    c.name === 'login' ||
                    c.name === 'summary' ||
                    c.name === 'code' ||
                    c.type === 'string'
                );
                const titleValue = titleField ? String(row[titleField.name] ?? '') : `#${row.id}`;
                const detailCols = columns
                  .filter((c) => c.name !== titleField?.name && c.name !== 'active')
                  .slice(0, 4);

                return (
                  <div
                    key={row.id}
                    onClick={() => onOpenRecord(row.id)}
                    className={cn(
                      'ink-panel group relative border-2 border-ink p-4 transition-all hover:-translate-y-1 hover:shadow-ink-lg flex flex-col justify-between cursor-pointer',
                      isSelected ? 'border-lime bg-lime/10' : 'bg-card'
                    )}
                  >
                    <div>
                      {/* Top bar: Checkbox, ID badge, Active Status */}
                      <div className="flex items-center justify-between gap-2 border-b border-ink/15 pb-2.5">
                        <div
                          className="flex items-center gap-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Checkbox
                            aria-label={`Select record #${row.id}`}
                            checked={isSelected}
                            onChange={() => toggleSelect(row.id as number)}
                            className="size-4 cursor-pointer accent-lime border-2 border-ink rounded-none bg-paper"
                          />
                          <span className="font-mono text-xs font-bold text-ink-soft">
                            #{row.id}
                          </span>
                        </div>
                        {row.active !== undefined && (
                          <span
                            className={cn(
                              'border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase',
                              row.active !== false
                                ? 'border-lime bg-lime/20 text-lime-800 dark:text-lime-300'
                                : 'border-ink/30 bg-card text-ink-faint'
                            )}
                          >
                            {row.active !== false ? 'Active' : 'Archived'}
                          </span>
                        )}
                      </div>

                      {/* Card Title */}
                      <div className="py-3">
                        <h3 className="font-display text-lg uppercase tracking-wide text-ink group-hover:text-lime-600 transition-colors line-clamp-2">
                          {titleValue || `#${row.id}`}
                        </h3>
                        {titleField && titleField.name !== 'name' && (
                          <span className="font-mono text-[10px] text-ink-faint uppercase">
                            {titleField.label}
                          </span>
                        )}
                      </div>

                      {/* Detail Fields */}
                      <div className="space-y-1.5 border-t border-dashed border-ink/15 pt-2 font-mono text-xs">
                        {detailCols.map((col) => (
                          <div
                            key={col.name}
                            className="flex items-center justify-between gap-2 text-ink-soft"
                          >
                            <span className="text-[11px] text-ink-faint uppercase truncate max-w-[45%]">
                              {col.label}:
                            </span>
                            <div className="truncate text-right">
                              <FieldCell field={col} row={row} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Card Footer */}
                    <div className="mt-4 flex items-center justify-between border-t border-ink/15 pt-2.5">
                      <span className="font-mono text-[10px] text-ink-faint">
                        {row.write_date ? formatDateTime(String(row.write_date), 'date') : '—'}
                      </span>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="font-mono text-xs group-hover:bg-lime group-hover:text-on-accent"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenRecord(row.id);
                        }}
                      >
                        Inspect →
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 3. True Kanban Stage Pipeline View */}
      {viewMode === 'pipeline' && (
        <div>
          {!groupingField ? (
            <div className="border-2 border-ink bg-paper p-8 text-center shadow-ink">
              <Doodle kind="sparkle" className="mx-auto size-8 text-pink mb-2" />
              <h3 className="font-display text-lg uppercase text-ink">
                No Workflow Pipeline Detected
              </h3>
              <p className="mt-1 font-mono text-xs text-ink-faint">
                Model &apos;{views.title}&apos; does not contain a state or stage enum field to
                organize columns.
              </p>
              <div className="mt-4 flex justify-center gap-3">
                <Button variant="outline" size="sm" onClick={() => setViewMode('table')}>
                  Switch to Table
                </Button>
                <Button variant="outline" size="sm" onClick={() => setViewMode('grid')}>
                  Switch to Cards Grid
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-4 overflow-x-auto pb-6 pt-1 items-start">
              {pipelineStages.map((stage, stageIdx) => {
                const stageRecords =
                  data?.records.filter((r) => String(r[groupingField.name] ?? '') === stage) ?? [];

                return (
                  <div
                    key={stage}
                    className="w-80 shrink-0 flex flex-col border-2 border-ink bg-paper shadow-ink"
                  >
                    {/* Stage Header */}
                    <div className="flex items-center justify-between border-b-2 border-ink bg-paper-raised px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="size-2.5 border border-ink bg-lime" />
                        <span className="font-display text-xs uppercase tracking-wider text-ink font-bold">
                          {stage}
                        </span>
                      </div>
                      <span className="border border-ink bg-paper px-2 py-0.5 font-mono text-xs font-bold text-ink-soft">
                        {stageRecords.length}
                      </span>
                    </div>

                    {/* Cards Column Body */}
                    <div className="flex-1 p-2 space-y-2.5 min-h-[350px] overflow-y-auto max-h-[600px] bg-paper/40">
                      {stageRecords.length === 0 ? (
                        <div className="p-6 text-center font-mono text-xs text-ink-faint border-2 border-dashed border-ink/20">
                          Empty stage
                        </div>
                      ) : (
                        stageRecords.map((row) => {
                          const titleField = columns.find(
                            (c) =>
                              c.name === 'name' ||
                              c.name === 'login' ||
                              c.name === 'summary' ||
                              c.name === 'code' ||
                              c.type === 'string'
                          );
                          const titleVal = titleField ? row[titleField.name] : null;
                          const detailCols = columns
                            .filter(
                              (c) =>
                                c.name !== titleField?.name &&
                                c.name !== 'active' &&
                                c.name !== groupingField?.name
                            )
                            .slice(0, 3);

                          return (
                            <div
                              key={row.id}
                              onClick={() => onOpenRecord(row.id as number)}
                              className="group cursor-pointer border-2 border-ink bg-paper-raised p-3 shadow-ink-sm hover:-translate-y-0.5 hover:shadow-ink transition-all"
                            >
                              <div className="flex items-center justify-between gap-2 border-b border-ink/15 pb-1.5">
                                <span className="font-mono text-xs font-bold text-ink-soft">
                                  #{row.id}
                                </span>
                                {row.active !== undefined && (
                                  <span
                                    className={cn(
                                      'border px-1 py-0.2 font-mono text-[9px] font-bold uppercase',
                                      row.active !== false
                                        ? 'border-lime bg-lime/20 text-lime-800 dark:text-lime-300'
                                        : 'border-ink/30 bg-card text-ink-faint'
                                    )}
                                  >
                                    {row.active !== false ? 'Active' : 'Archived'}
                                  </span>
                                )}
                              </div>

                              <h4 className="mt-2 font-display text-sm uppercase tracking-wide text-ink group-hover:text-lime-600 transition-colors line-clamp-2">
                                {titleVal ? String(titleVal) : `#${row.id}`}
                              </h4>

                              {/* Key Fields Preview */}
                              <div className="mt-2 space-y-1 border-t border-dashed border-ink/15 pt-1.5 font-mono text-[11px]">
                                {detailCols.map((col) => (
                                  <div
                                    key={col.name}
                                    className="flex items-center justify-between gap-1 text-ink-soft"
                                  >
                                    <span className="text-[10px] text-ink-faint uppercase truncate max-w-[45%]">
                                      {col.label}:
                                    </span>
                                    <div className="truncate text-right">
                                      <FieldCell field={col} row={row} />
                                    </div>
                                  </div>
                                ))}
                              </div>

                              {/* Card Actions: Prev Stage, Next Stage, Inspect */}
                              <div
                                className="mt-3 flex items-center justify-between border-t border-ink/15 pt-2"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div className="flex items-center gap-1">
                                  {stageIdx > 0 && (
                                    <Button
                                      variant="outline"
                                      size="icon-xs"
                                      title={`Move to ${pipelineStages[stageIdx - 1]}`}
                                      disabled={mutations.save.isPending}
                                      onClick={() =>
                                        handleMoveStage(
                                          row.id as number,
                                          pipelineStages[stageIdx - 1]
                                        )
                                      }
                                      className="size-6 text-xs hover:bg-lime hover:text-on-accent"
                                    >
                                      ←
                                    </Button>
                                  )}
                                  {stageIdx < pipelineStages.length - 1 && (
                                    <Button
                                      variant="outline"
                                      size="icon-xs"
                                      title={`Move to ${pipelineStages[stageIdx + 1]}`}
                                      disabled={mutations.save.isPending}
                                      onClick={() =>
                                        handleMoveStage(
                                          row.id as number,
                                          pipelineStages[stageIdx + 1]
                                        )
                                      }
                                      className="size-6 text-xs hover:bg-lime hover:text-on-accent"
                                    >
                                      →
                                    </Button>
                                  )}
                                </div>

                                <Button
                                  variant="ghost"
                                  size="xs"
                                  className="font-mono text-xs hover:bg-lime hover:text-on-accent"
                                  onClick={() => onOpenRecord(row.id as number)}
                                >
                                  Inspect →
                                </Button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Shared Pagination Footer */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-2 border-ink bg-paper px-4 py-3 font-mono text-xs shadow-ink">
        <div className="text-ink-soft">
          Showing <span className="font-bold text-ink">{total === 0 ? 0 : offset + 1}</span> to{' '}
          <span className="font-bold text-ink">{Math.min(offset + pageSize, total)}</span> of{' '}
          <span className="font-bold text-ink">{total}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page <= 1 || isPlaceholderData}
            onClick={() => setPage(1)}
            title="First Page"
          >
            <ChevronsLeftIcon className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page <= 1 || isPlaceholderData}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            title="Previous Page"
          >
            <ChevronRightIcon className="size-4 rotate-180" />
          </Button>

          <span className="border-2 border-ink bg-paper-raised px-3 py-1 font-bold">
            {page} / {totalPages}
          </span>

          <Button
            variant="outline"
            size="icon-sm"
            disabled={page >= totalPages || isPlaceholderData}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            title="Next Page"
          >
            <ChevronRightIcon className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page >= totalPages || isPlaceholderData}
            onClick={() => setPage(totalPages)}
            title="Last Page"
          >
            <ChevronsRightIcon className="size-4" />
          </Button>
        </div>
      </div>

      {/* Floating Batch Action Toolbar */}
      {selectedIds.length > 0 && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 border-2 border-ink bg-paper px-4 py-2.5 shadow-[4px_4px_0_0_var(--ink)] animate-in fade-in slide-in-from-bottom-5">
          <span className="border-2 border-ink bg-lime px-2.5 py-1 font-mono text-xs font-bold text-on-accent">
            {selectedIds.length} SELECTED
          </span>

          {views.permissions.unlink && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleBulkArchive}
              disabled={isBulkArchiving}
              className="gap-1.5 hover:bg-pink hover:text-on-pink"
            >
              {isBulkArchiving ? (
                <LoadingSpinner className="size-3.5" />
              ) : (
                <ArchiveIcon className="size-3.5" />
              )}
              Bulk Archive
            </Button>
          )}

          {/* Mass Tagging Action */}
          <Popover open={tagPopoverOpen} onOpenChange={setTagPopoverOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={isMassTagging}
                title="Tag selected records"
              >
                {isMassTagging ? (
                  <LoadingSpinner className="size-3.5" />
                ) : (
                  <TagIcon className="size-3.5" />
                )}
                Tag Records
              </Button>
            </PopoverTrigger>
            <PopoverContent align="center" className="w-56 p-2 space-y-2 font-sans shadow-ink-lg">
              <div className="flex items-center justify-between border-b border-ink/20 pb-1.5 px-1 font-display text-xs uppercase tracking-wider text-ink">
                <span>Assign Sticker Tag</span>
                <TagIcon className="size-3 text-lime" />
              </div>
              {availableTags.length === 0 ? (
                <div className="p-3 text-center font-mono text-xs text-ink-faint">
                  No tags available.
                </div>
              ) : (
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {availableTags.map((tag) => (
                    <Button
                      key={tag.id}
                      type="button"
                      onClick={() => handleMassTag(tag.id)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 text-xs font-mono hover:bg-lime hover:text-on-accent text-left transition-colors border border-transparent hover:border-ink"
                    >
                      <span
                        className="size-2.5 border border-ink shrink-0"
                        style={{ backgroundColor: tag.color || 'var(--mw-yellow)' }}
                      />
                      <span className="truncate">{tag.name}</span>
                    </Button>
                  ))}
                </div>
              )}
            </PopoverContent>
          </Popover>

          <Button variant="outline" size="sm" onClick={handleExportCsv} className="gap-1.5">
            <DownloadIcon className="size-3.5" />
            Export CSV
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedIds([])}
            className="font-mono text-xs hover:bg-ink hover:text-paper"
          >
            Clear
          </Button>
        </div>
      )}

      {/* Universal CSV Import Wizard Dialog */}
      <ImportWizardDialog
        open={importWizardOpen}
        onOpenChange={setImportWizardOpen}
        model={model}
        views={views}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ['records', model] });
          setPage(1);
        }}
      />

      {/* Advanced Query Builder Dialog */}
      {queryBuilderOpen && (
        <QueryBuilderDialog
          open
          onOpenChange={setQueryBuilderOpen}
          model={model}
          views={views}
          initialRules={advancedRules}
          initialConjunction={advancedConjunction}
          onApply={(rules, conj) => {
            setAdvancedRules(rules);
            setAdvancedConjunction(conj);
            setPage(1);
          }}
        />
      )}
    </div>
  );
}
