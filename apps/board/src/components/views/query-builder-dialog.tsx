import { SelectField } from '@moonwitness/ui/components/select-field';
import { useState } from 'react';
import { Filter, Plus, Trash2, Bookmark, Check, RotateCcw, Sparkles } from 'lucide-react';
import type { ResolvedViews } from '@moonwitness/client';
import { Button } from '@moonwitness/ui/components/button';
import { Input } from '@moonwitness/ui/components/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@moonwitness/ui/components/dialog';
import { Doodle } from '@moonwitness/ui/components/effects';
import { cn } from '@/lib/utils';

export interface FilterRule {
  id: string;
  field: string;
  operator: '=' | '!=' | 'ilike' | '>' | '<' | '>=' | '<=' | 'is_set' | 'is_null';
  value: string;
}

export interface SavedQuery {
  id: string;
  name: string;
  conjunction: 'all' | 'any';
  rules: FilterRule[];
}

interface QueryBuilderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: string;
  views: ResolvedViews;
  initialRules?: FilterRule[];
  initialConjunction?: 'all' | 'any';
  onApply: (rules: FilterRule[], conjunction: 'all' | 'any') => void;
}

export function QueryBuilderDialog({
  open,
  onOpenChange,
  model,
  views,
  initialRules = [],
  initialConjunction = 'all',
  onApply,
}: QueryBuilderDialogProps) {
  const filterableFields = views.fields.filter((f) => f.type !== 'one2many');
  const storageKey = `moonwitness_saved_filters_${model}`;
  const [conjunction, setConjunction] = useState<'all' | 'any'>(initialConjunction);
  const [rules, setRules] = useState<FilterRule[]>(() =>
    initialRules.length > 0
      ? initialRules
      : [
          {
            id: `rule_${Date.now()}`,
            field: filterableFields[0]?.name || 'name',
            operator: 'ilike',
            value: '',
          },
        ]
  );
  const [saveName, setSaveName] = useState('');
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored ? (JSON.parse(stored) as SavedQuery[]) : [];
    } catch {
      return [];
    }
  });
  const [showSaveInput, setShowSaveInput] = useState(false);

  const handleAddRule = () => {
    const firstField = filterableFields[0]?.name || 'name';
    setRules((prev) => [
      ...prev,
      {
        id: `rule_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        field: firstField,
        operator: 'ilike',
        value: '',
      },
    ]);
  };

  const handleRemoveRule = (id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id));
  };

  const handleUpdateRule = (id: string, updates: Partial<FilterRule>) => {
    setRules((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        const updated = { ...r, ...updates };
        // Reset operator / value defaults if field changed
        if (updates.field && updates.field !== r.field) {
          const fieldMeta = views.fields.find((f) => f.name === updates.field);
          if (fieldMeta?.type === 'boolean') {
            updated.operator = '=';
            updated.value = 'true';
          } else if (fieldMeta?.type === 'integer') {
            updated.operator = '=';
            updated.value = '0';
          } else {
            updated.operator = 'ilike';
            updated.value = '';
          }
        }
        return updated;
      })
    );
  };

  const handleSaveCurrentQuery = () => {
    if (!saveName.trim()) return;
    const newSaved: SavedQuery = {
      id: `query_${Date.now()}`,
      name: saveName.trim(),
      conjunction,
      rules: [...rules],
    };
    const updated = [newSaved, ...savedQueries.filter((q) => q.name !== newSaved.name)];
    setSavedQueries(updated);
    try {
      localStorage.setItem(storageKey, JSON.stringify(updated));
    } catch {
      // ignore
    }
    setSaveName('');
    setShowSaveInput(false);
  };

  const handleDeleteSaved = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = savedQueries.filter((q) => q.id !== id);
    setSavedQueries(updated);
    try {
      localStorage.setItem(storageKey, JSON.stringify(updated));
    } catch {
      // ignore
    }
  };

  const handleLoadSaved = (saved: SavedQuery) => {
    setConjunction(saved.conjunction);
    setRules(saved.rules);
  };

  const handleReset = () => {
    const firstField = filterableFields[0]?.name || 'name';
    setRules([
      {
        id: `rule_${Date.now()}`,
        field: firstField,
        operator: 'ilike',
        value: '',
      },
    ]);
    setConjunction('all');
  };

  const handleApply = () => {
    const activeRules = rules.filter(
      (r) => r.operator === 'is_set' || r.operator === 'is_null' || r.value.trim() !== ''
    );
    onApply(activeRules, conjunction);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl border-4 border-ink bg-paper p-6 shadow-ink-lg rounded-none">
        <DialogHeader className="border-b-2 border-ink pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Filter className="size-6 text-lime" />
              <DialogTitle className="font-display text-2xl uppercase tracking-wider text-ink">
                Advanced Query Builder: {views.title}
              </DialogTitle>
            </div>
            <Doodle kind="crown" className="size-5 text-pink" />
          </div>
          <DialogDescription className="font-mono text-xs text-ink-faint">
            Construct complex multi-criteria domains with compound operators and saved presets.
          </DialogDescription>
        </DialogHeader>

        {/* Saved Filters Pill Row */}
        {savedQueries.length > 0 && (
          <div className="border-2 border-ink bg-card p-2.5 font-mono text-xs space-y-2">
            <span className="block text-[10px] font-bold uppercase tracking-wider text-ink-faint">
              Saved Presets:
            </span>
            <div className="flex flex-wrap gap-1.5">
              {savedQueries.map((saved) => (
                <Button
                  key={saved.id}
                  type="button"
                  onClick={() => handleLoadSaved(saved)}
                  className="group inline-flex items-center gap-1.5 border-2 border-ink bg-paper px-2 py-0.5 text-xs font-bold shadow-[2px_2px_0_0_var(--ink)] hover:bg-lime hover:text-on-accent transition-colors"
                >
                  <Bookmark className="size-3 text-ink-faint group-hover:text-on-accent" />
                  <span>{saved.name}</span>
                  <span
                    onClick={(e) => handleDeleteSaved(saved.id, e)}
                    className="ml-1 text-ink-faint hover:text-pink transition-colors"
                    title="Delete preset"
                  >
                    ×
                  </span>
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Conjunction Logic: Match ALL vs Match ANY */}
        <div className="flex items-center justify-between border-2 border-ink bg-paper-raised p-2 font-mono text-xs">
          <span className="font-bold text-ink uppercase">Condition Matching:</span>
          <div className="flex items-center border border-ink bg-paper p-0.5 shadow-ink-sm">
            <Button
              type="button"
              onClick={() => setConjunction('all')}
              className={cn(
                'px-3 py-1 font-bold uppercase transition-colors',
                conjunction === 'all'
                  ? 'bg-lime text-on-accent border border-ink'
                  : 'text-ink-faint'
              )}
            >
              Match ALL (AND)
            </Button>
            <Button
              type="button"
              onClick={() => setConjunction('any')}
              className={cn(
                'px-3 py-1 font-bold uppercase transition-colors',
                conjunction === 'any'
                  ? 'bg-lime text-on-accent border border-ink'
                  : 'text-ink-faint'
              )}
            >
              Match ANY (OR)
            </Button>
          </div>
        </div>

        {/* Dynamic Rules List */}
        <div className="max-h-72 overflow-y-auto space-y-2.5 pr-1 font-mono text-xs">
          {rules.map((rule, idx) => {
            const fieldMeta = views.fields.find((f) => f.name === rule.field);
            const isBool = fieldMeta?.type === 'boolean';
            const isNullOp = rule.operator === 'is_set' || rule.operator === 'is_null';

            return (
              <div
                key={rule.id}
                className="flex flex-wrap items-center gap-2 border-2 border-ink bg-card p-2 shadow-ink-sm"
              >
                <span className="font-bold text-ink-faint w-5 text-center">
                  {idx === 0 ? 'Where' : conjunction === 'all' ? 'AND' : 'OR'}
                </span>

                {/* Field Selector */}
                <SelectField
                  value={rule.field}
                  onChange={(e) => handleUpdateRule(rule.id, { field: e.target.value })}
                  className="h-8 border-2 border-ink bg-paper px-2 text-xs text-ink outline-none min-w-[130px]"
                >
                  {filterableFields.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.label} ({f.name})
                    </option>
                  ))}
                </SelectField>

                {/* Operator Selector */}
                <SelectField
                  value={rule.operator}
                  onChange={(e) =>
                    handleUpdateRule(rule.id, {
                      operator: e.target.value as FilterRule['operator'],
                    })
                  }
                  className="h-8 border-2 border-ink bg-paper px-2 text-xs text-ink outline-none min-w-[110px]"
                >
                  <option value="ilike">contains</option>
                  <option value="=">equals</option>
                  <option value="!=">not equal</option>
                  <option value=">">greater than</option>
                  <option value="<">less than</option>
                  <option value=">=">&gt;=</option>
                  <option value="<=">&lt;=</option>
                  <option value="is_set">is set</option>
                  <option value="is_null">is not set</option>
                </SelectField>

                {/* Value Input */}
                {!isNullOp && (
                  <div className="flex-1 min-w-[140px]">
                    {isBool ? (
                      <SelectField
                        value={rule.value}
                        onChange={(e) => handleUpdateRule(rule.id, { value: e.target.value })}
                        className="h-8 w-full border-2 border-ink bg-paper px-2 text-xs text-ink outline-none"
                      >
                        <option value="true">True / Active</option>
                        <option value="false">False / Inactive</option>
                      </SelectField>
                    ) : (
                      <Input
                        placeholder="Search value..."
                        value={rule.value}
                        onChange={(e) => handleUpdateRule(rule.id, { value: e.target.value })}
                        className="h-8 text-xs border-2 border-ink"
                      />
                    )}
                  </div>
                )}

                {/* Remove Button */}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleRemoveRule(rule.id)}
                  disabled={rules.length === 1}
                  className="size-8 text-ink-faint hover:text-pink hover:bg-pink/10 shrink-0"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>

        {/* Add Condition & Save Preset Buttons */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-ink pt-3 font-mono text-xs">
          <Button variant="outline" size="sm" onClick={handleAddRule} className="gap-1.5">
            <Plus className="size-3.5" /> Add Condition
          </Button>

          <div className="flex items-center gap-2">
            {!showSaveInput ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowSaveInput(true)}
                className="gap-1 text-ink-soft hover:text-ink"
              >
                <Bookmark className="size-3.5" /> Save Preset
              </Button>
            ) : (
              <div className="flex items-center gap-1">
                <Input
                  placeholder="Preset name..."
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  className="h-7 w-36 text-xs border-2 border-ink"
                />
                <Button
                  size="xs"
                  onClick={handleSaveCurrentQuery}
                  disabled={!saveName.trim()}
                  className="gap-1"
                >
                  <Check className="size-3" /> Save
                </Button>
                <Button
                  type="button"
                  onClick={() => setShowSaveInput(false)}
                  className="text-xs text-ink-faint hover:text-pink px-1"
                >
                  ×
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Dialog Action Buttons */}
        <div className="flex items-center justify-between pt-2">
          <Button variant="outline" size="sm" onClick={handleReset} className="gap-1">
            <RotateCcw className="size-3.5" /> Reset
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleApply} className="gap-1.5">
              <Sparkles className="size-3.5 text-on-accent" />
              <span>Apply Filters</span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
