import {
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
} from '@moonwitness/ui/components/table';
import { SelectField } from '@moonwitness/ui/components/select-field';
import { Input } from '@moonwitness/ui/components/input';
import { useState, useRef, useMemo, useCallback } from 'react';
import {
  Upload,
  FileSpreadsheet,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Check,
  RotateCcw,
} from 'lucide-react';
import type { ResolvedViews } from '@moonwitness/client';
import { client } from '@/lib/client';
import { Button } from '@moonwitness/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@moonwitness/ui/components/dialog';
import { Doodle } from '@moonwitness/ui/components/effects';
import { cn } from '@/lib/utils';

interface ImportWizardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: string;
  views: ResolvedViews;
  onSuccess: () => void;
}

type WizardStep = 'upload' | 'mapping' | 'preview' | 'importing' | 'completed';

interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

// RFC-4180 compliant CSV parser
function parseCsv(text: string): ParsedCsv {
  const lines: string[][] = [];
  let currentRow: string[] = [];
  let currentVal = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentVal += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        currentVal += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',' || char === ';') {
        currentRow.push(currentVal.trim());
        currentVal = '';
      } else if (char === '\r') {
        if (nextChar === '\n') i++;
        currentRow.push(currentVal.trim());
        currentVal = '';
        if (currentRow.some((c) => c.length > 0)) lines.push(currentRow);
        currentRow = [];
      } else if (char === '\n') {
        currentRow.push(currentVal.trim());
        currentVal = '';
        if (currentRow.some((c) => c.length > 0)) lines.push(currentRow);
        currentRow = [];
      } else {
        currentVal += char;
      }
    }
  }

  if (currentVal.length > 0 || currentRow.length > 0) {
    currentRow.push(currentVal.trim());
    if (currentRow.some((c) => c.length > 0)) lines.push(currentRow);
  }

  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = lines[0].map((h) => h.replace(/^["']|["']$/g, '').trim());
  const rows = lines.slice(1);
  return { headers, rows };
}

export function ImportWizardDialog({
  open,
  onOpenChange,
  model,
  views,
  onSuccess,
}: ImportWizardDialogProps) {
  const [step, setStep] = useState<WizardStep>('upload');
  const [fileName, setFileName] = useState<string>('');
  const [parsed, setParsed] = useState<ParsedCsv>({ headers: [], rows: [] });
  // Map csvHeader -> target model fieldName (or '' to skip)
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [isDragging, setIsDragging] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [importResult, setImportResult] = useState<{
    succeeded: number;
    failed: number;
    errors: string[];
  }>({ succeeded: 0, failed: 0, errors: [] });

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Eligible model fields for import (exclude id, computed/relation arrays)
  const importableFields = useMemo(() => {
    return views.fields.filter(
      (f) =>
        f.type !== 'one2many' &&
        !['id', 'create_date', 'write_date', 'create_uid', 'write_uid'].includes(f.name)
    );
  }, [views]);

  const requiredFields = useMemo(() => {
    return importableFields.filter((f) => f.required);
  }, [importableFields]);

  const handleReset = () => {
    setStep('upload');
    setFileName('');
    setParsed({ headers: [], rows: [] });
    setColumnMapping({});
    setImportProgress(0);
    setImportResult({ succeeded: 0, failed: 0, errors: [] });
  };

  const handleFileProcess = (file: File) => {
    if (!file.name.endsWith('.csv') && !file.name.endsWith('.txt')) {
      alert('Please upload a valid CSV file.');
      return;
    }

    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      const res = parseCsv(content);
      if (res.headers.length === 0 || res.rows.length === 0) {
        alert('The uploaded CSV file is empty or formatted incorrectly.');
        return;
      }
      setParsed(res);

      // Auto-map headers
      const initialMap: Record<string, string> = {};
      for (const header of res.headers) {
        const normalized = header.toLowerCase().replace(/[^a-z0-9]/g, '');
        const matched = importableFields.find(
          (f) =>
            f.name.toLowerCase() === normalized ||
            f.label.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized
        );
        initialMap[header] = matched ? matched.name : '';
      }
      setColumnMapping(initialMap);
      setStep('mapping');
    };
    reader.readAsText(file);
  };

  // Convert row into record object based on mapping
  const transformRow = useCallback(
    (row: string[]): Record<string, unknown> => {
      const record: Record<string, unknown> = {};
      parsed.headers.forEach((header, idx) => {
        const targetField = columnMapping[header];
        if (targetField && row[idx] !== undefined && row[idx] !== '') {
          const fieldMeta = views.fields.find((f) => f.name === targetField);
          let val: unknown = row[idx];
          if (fieldMeta?.type === 'integer') {
            const parsedInt = parseInt(row[idx], 10);
            val = isNaN(parsedInt) ? null : parsedInt;
          } else if (fieldMeta?.type === 'boolean') {
            val = ['true', '1', 'yes', 'y', 't'].includes(row[idx].toLowerCase());
          }
          record[targetField] = val;
        }
      });
      return record;
    },
    [parsed.headers, columnMapping, views.fields]
  );

  // Preview transformed data (up to 5 rows)
  const previewRows = useMemo(() => {
    return parsed.rows.slice(0, 5).map(transformRow);
  }, [parsed.rows, transformRow]);

  // Validation check for unmapped required fields
  const missingRequired = useMemo(() => {
    const mappedTargets = new Set(Object.values(columnMapping).filter(Boolean));
    return requiredFields.filter((f) => !mappedTargets.has(f.name));
  }, [requiredFields, columnMapping]);

  // Execute import
  const handleExecuteImport = async () => {
    setStep('importing');
    setImportProgress(0);

    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    const total = parsed.rows.length;
    for (let i = 0; i < total; i++) {
      const row = parsed.rows[i];
      const payload = transformRow(row);

      // Check required fields
      const rowMissing = requiredFields.filter(
        (f) => payload[f.name] === undefined || payload[f.name] === null || payload[f.name] === ''
      );

      if (rowMissing.length > 0) {
        failed++;
        errors.push(`Row ${i + 1}: Missing required field '${rowMissing[0].label}'`);
        setImportProgress(Math.round(((i + 1) / total) * 100));
        continue;
      }

      try {
        await client.model(model).create(payload);
        succeeded++;
      } catch (err) {
        failed++;
        errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Create error'}`);
      }

      setImportProgress(Math.round(((i + 1) / total) * 100));
    }

    setImportResult({ succeeded, failed, errors });
    setStep('completed');
    if (succeeded > 0) {
      onSuccess();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl border-4 border-ink bg-paper p-6 shadow-ink-lg rounded-none">
        <DialogHeader className="border-b-2 border-ink pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="size-6 text-lime" />
              <DialogTitle className="font-display text-2xl uppercase tracking-wider text-ink">
                Import CSV: {views.title}
              </DialogTitle>
            </div>
            <Doodle kind="sparkle" className="size-5 text-pink" />
          </div>
          <DialogDescription className="font-mono text-xs text-ink-faint">
            Batch import records from standard CSV into{' '}
            <span className="text-ink font-bold">{model}</span>.
          </DialogDescription>
        </DialogHeader>

        {/* Wizard Steps Navigation Bar */}
        <div className="flex items-center justify-between border-2 border-ink bg-card p-2 text-xs font-mono">
          <div
            className={cn(
              'px-2 py-1 flex items-center gap-1.5 font-bold uppercase',
              step === 'upload' ? 'bg-lime text-on-accent border border-ink' : 'text-ink-faint'
            )}
          >
            <span>1. Upload</span>
          </div>
          <ArrowRight className="size-3 text-ink-faint" />
          <div
            className={cn(
              'px-2 py-1 flex items-center gap-1.5 font-bold uppercase',
              step === 'mapping' ? 'bg-lime text-on-accent border border-ink' : 'text-ink-faint'
            )}
          >
            <span>2. Map Columns</span>
          </div>
          <ArrowRight className="size-3 text-ink-faint" />
          <div
            className={cn(
              'px-2 py-1 flex items-center gap-1.5 font-bold uppercase',
              step === 'preview' ? 'bg-lime text-on-accent border border-ink' : 'text-ink-faint'
            )}
          >
            <span>3. Preview</span>
          </div>
          <ArrowRight className="size-3 text-ink-faint" />
          <div
            className={cn(
              'px-2 py-1 flex items-center gap-1.5 font-bold uppercase',
              step === 'importing' || step === 'completed'
                ? 'bg-lime text-on-accent border border-ink'
                : 'text-ink-faint'
            )}
          >
            <span>4. Complete</span>
          </div>
        </div>

        {/* STEP 1: UPLOAD */}
        {step === 'upload' && (
          <div className="space-y-4 py-2">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const file = e.dataTransfer.files[0];
                if (file) handleFileProcess(file);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                'flex flex-col items-center justify-center border-4 border-dashed p-10 cursor-pointer transition-all',
                isDragging
                  ? 'border-pink bg-pink/10 shadow-ink'
                  : 'border-ink/40 bg-card hover:border-ink hover:bg-paper-raised'
              )}
            >
              <Upload className="size-10 text-ink-soft mb-3" />
              <p className="font-display text-base uppercase tracking-wider text-ink text-center">
                Click or drag & drop CSV file here
              </p>
              <p className="font-mono text-xs text-ink-faint mt-1">
                Standard RFC-4180 CSV, UTF-8 encoded
              </p>
              <Input
                ref={fileInputRef}
                type="file"
                accept=".csv,.txt"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileProcess(file);
                }}
              />
            </div>
          </div>
        )}

        {/* STEP 2: COLUMN MAPPING */}
        {step === 'mapping' && (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between font-mono text-xs">
              <span className="text-ink-soft">
                File: <strong className="text-ink">{fileName}</strong> ({parsed.rows.length} rows
                found)
              </span>
              {missingRequired.length > 0 && (
                <span className="inline-flex items-center gap-1 border border-pink bg-pink/10 text-pink px-2 py-0.5 font-bold">
                  <AlertCircle className="size-3.5" /> Missing:{' '}
                  {missingRequired.map((f) => f.label).join(', ')}
                </span>
              )}
            </div>

            <div className="max-h-60 overflow-y-auto border-2 border-ink bg-card divide-y-2 divide-ink">
              <Table className="w-full font-mono text-xs text-left">
                <TableHead className="bg-paper-raised border-b-2 border-ink text-ink font-bold uppercase">
                  <TableRow>
                    <TableHeader className="p-2.5">CSV Column</TableHeader>
                    <TableHeader className="p-2.5">Sample Value</TableHeader>
                    <TableHeader className="p-2.5">Target Field</TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody className="divide-y border-ink/20">
                  {parsed.headers.map((hdr, i) => (
                    <TableRow key={hdr} className="hover:bg-paper-raised/60">
                      <TableCell className="p-2.5 font-bold text-ink">{hdr}</TableCell>
                      <TableCell className="p-2.5 text-ink-faint truncate max-w-[150px]">
                        {parsed.rows[0]?.[i] ?? '—'}
                      </TableCell>
                      <TableCell className="p-2.5">
                        <SelectField
                          value={columnMapping[hdr] || ''}
                          onChange={(e) =>
                            setColumnMapping((prev) => ({
                              ...prev,
                              [hdr]: e.target.value,
                            }))
                          }
                          className="h-8 w-full border-2 border-ink bg-paper px-2 text-xs font-mono text-ink outline-none"
                        >
                          <option value="">-- Skip / Do Not Import --</option>
                          {importableFields.map((f) => (
                            <option key={f.name} value={f.name}>
                              {f.label} {f.required ? '(*)' : ''}
                            </option>
                          ))}
                        </SelectField>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between pt-2">
              <Button variant="outline" size="sm" onClick={handleReset} className="gap-1">
                <RotateCcw className="size-3.5" /> Re-upload
              </Button>
              <Button
                size="sm"
                onClick={() => setStep('preview')}
                disabled={Object.values(columnMapping).filter(Boolean).length === 0}
                className="gap-1.5"
              >
                <span>Preview Data</span>
                <ArrowRight className="size-3.5" />
              </Button>
            </div>
          </div>
        )}

        {/* STEP 3: PREVIEW & DRY RUN */}
        {step === 'preview' && (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between font-mono text-xs">
              <span className="text-ink-soft">
                Ready to import <strong className="text-ink">{parsed.rows.length} records</strong>.
              </span>
              {missingRequired.length > 0 ? (
                <span className="text-pink font-bold flex items-center gap-1">
                  <AlertCircle className="size-3.5" /> Warning:{' '}
                  {missingRequired.map((f) => f.label).join(', ')} required!
                </span>
              ) : (
                <span className="text-lime-deep font-bold flex items-center gap-1">
                  <Check className="size-3.5" /> All required fields mapped
                </span>
              )}
            </div>

            <div className="max-h-60 overflow-x-auto border-2 border-ink bg-card">
              <Table className="w-full font-mono text-xs text-left">
                <TableHead className="bg-paper-raised border-b-2 border-ink text-ink font-bold uppercase">
                  <TableRow>
                    <TableHeader className="p-2 border-r border-ink/20">#</TableHeader>
                    {Object.entries(columnMapping)
                      .filter(([, target]) => Boolean(target))
                      .map(([csvHdr, target]) => {
                        const meta = views.fields.find((f) => f.name === target);
                        return (
                          <TableHeader key={csvHdr} className="p-2 border-r border-ink/20">
                            {meta?.label ?? target}
                          </TableHeader>
                        );
                      })}
                  </TableRow>
                </TableHead>
                <TableBody className="divide-y border-ink/20">
                  {previewRows.map((record, idx) => (
                    <TableRow key={idx} className="hover:bg-paper-raised/60">
                      <TableCell className="p-2 text-ink-faint border-r border-ink/20">
                        {idx + 1}
                      </TableCell>
                      {Object.entries(columnMapping)
                        .filter(([, target]) => Boolean(target))
                        .map(([csvHdr, target]) => (
                          <TableCell
                            key={csvHdr}
                            className="p-2 text-ink border-r border-ink/20 truncate max-w-[180px]"
                          >
                            {String(record[target] ?? '') || (
                              <em className="text-ink-faint text-[10px]">empty</em>
                            )}
                          </TableCell>
                        ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStep('mapping')}
                className="gap-1"
              >
                <ArrowLeft className="size-3.5" /> Back to Mapping
              </Button>
              <Button
                size="sm"
                onClick={handleExecuteImport}
                disabled={missingRequired.length > 0}
                className="gap-1.5"
              >
                <Upload className="size-3.5" />
                <span>Start Import ({parsed.rows.length} rows)</span>
              </Button>
            </div>
          </div>
        )}

        {/* STEP 4: IMPORTING IN PROGRESS */}
        {step === 'importing' && (
          <div className="space-y-6 py-6 text-center">
            <Loader2 className="mx-auto size-10 animate-spin text-ink" />
            <div className="space-y-2">
              <h3 className="font-display text-xl uppercase tracking-wider text-ink">
                Importing Records...
              </h3>
              <p className="font-mono text-xs text-ink-faint">
                Processing {parsed.rows.length} rows into database
              </p>
            </div>

            {/* Neo-brutalist Progress Bar */}
            <div className="mx-auto max-w-md border-2 border-ink bg-card p-1 shadow-ink-sm">
              <div
                className="h-5 bg-lime border border-ink transition-all duration-200"
                style={{ width: `${importProgress}%` }}
              />
            </div>
            <p className="font-mono text-sm font-bold text-ink">{importProgress}%</p>
          </div>
        )}

        {/* STEP 5: COMPLETED */}
        {step === 'completed' && (
          <div className="space-y-4 py-4">
            <div className="border-2 border-ink bg-card p-5 text-center space-y-3 shadow-ink-sm">
              <CheckCircle2 className="mx-auto size-10 text-lime" />
              <h3 className="font-display text-xl uppercase tracking-wider text-ink">
                Import Finished!
              </h3>
              <div className="flex justify-center gap-6 font-mono text-sm pt-2">
                <div className="border border-ink bg-lime/20 px-3 py-1.5">
                  <span className="block text-[10px] uppercase text-ink-faint">Success</span>
                  <strong className="text-base text-ink">{importResult.succeeded}</strong>
                </div>
                <div className="border border-ink bg-pink/20 px-3 py-1.5">
                  <span className="block text-[10px] uppercase text-ink-faint">Failed</span>
                  <strong className="text-base text-pink">{importResult.failed}</strong>
                </div>
              </div>
            </div>

            {importResult.errors.length > 0 && (
              <div className="max-h-36 overflow-y-auto border-2 border-ink bg-card p-3 font-mono text-xs text-pink space-y-1">
                <p className="font-bold uppercase pb-1 border-b border-ink/20">Error Logs:</p>
                {importResult.errors.map((err, i) => (
                  <p key={i}>{err}</p>
                ))}
              </div>
            )}

            <div className="flex justify-end pt-2">
              <Button
                size="sm"
                onClick={() => {
                  onOpenChange(false);
                  handleReset();
                }}
              >
                Close & View Records
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
