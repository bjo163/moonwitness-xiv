'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useViews } from '@/hooks/use-model';
import { Skeleton } from '@moonwitness/ui/components/skeleton';
import { Doodle } from '@moonwitness/ui/components/effects';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { ListView } from '@/components/views/list-view';
import { FormView } from '@/components/views/form-view';

export function ModelPage() {
  const params = useParams<{ model: string; id?: string }>();
  const model = params?.model ?? '';
  const id = params?.id;
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data: views, isLoading, error } = useViews(model);

  const isCreate = id === 'new' || searchParams?.get('create') === '1';
  const isEdit = !isCreate && Boolean(id);
  const recordId = isEdit && id ? parseInt(id, 10) : undefined;
  const relationParentModel = searchParams?.get('relation_parent_model');
  const relationParentIdValue = searchParams?.get('relation_parent_id');
  const relationParentField = searchParams?.get('relation_field');
  const parsedRelationParentId =
    relationParentIdValue && /^\d+$/u.test(relationParentIdValue)
      ? Number(relationParentIdValue)
      : Number.NaN;
  const relationField = views?.fields.find(
    (field) =>
      field.name === relationParentField &&
      field.type === 'many2one' &&
      field.relation === relationParentModel &&
      !field.readonly &&
      !field.writeOnly
  );
  const relationParent =
    isCreate &&
    relationField &&
    Number.isSafeInteger(parsedRelationParentId) &&
    parsedRelationParentId > 0
      ? { model: relationField.relation!, id: parsedRelationParentId, field: relationField.name }
      : undefined;

  const breadcrumbs = views
    ? [
        {
          label: views.title,
          to: id ? `/board/m/${model}` : undefined,
        },
        ...(isCreate ? [{ label: 'New Record' }] : []),
        ...(isEdit ? [{ label: `#${id}` }] : []),
      ]
    : [];

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-6 w-48 bg-ink/10" />
        <Skeleton className="h-14 w-72 bg-ink/10" />
        <Skeleton className="h-96 w-full bg-ink/10" />
      </div>
    );
  }

  if (error || !views) {
    return (
      <div className="ink-panel p-12 text-center bg-card">
        <Doodle kind="star" className="mx-auto size-10 text-pink mb-4" />
        <h2 className="font-display text-2xl uppercase">Failed to load model views</h2>
        <p className="mt-2 text-ink-soft">
          Model &apos;{model}&apos; might not exist or you do not have permission to view it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Breadcrumbs items={breadcrumbs} />

      {isCreate ? (
        <FormView
          model={model}
          views={views}
          initialValues={relationParent ? { [relationParent.field]: relationParent.id } : undefined}
          onBack={() =>
            router.push(
              relationParent
                ? `/board/m/${relationParent.model}/${relationParent.id}`
                : `/board/m/${model}`
            )
          }
          onSaved={(newId) =>
            router.replace(
              relationParent
                ? `/board/m/${relationParent.model}/${relationParent.id}`
                : `/board/m/${model}/${newId}`
            )
          }
        />
      ) : isEdit && recordId !== undefined && !Number.isNaN(recordId) ? (
        <FormView
          model={model}
          views={views}
          recordId={recordId}
          onBack={() => router.push(`/board/m/${model}`)}
        />
      ) : (
        <ListView
          model={model}
          views={views}
          onOpenRecord={(recId) => router.push(`/board/m/${model}/${recId}`)}
          onCreateRecord={() => router.push(`/board/m/${model}/new`)}
        />
      )}
    </div>
  );
}
