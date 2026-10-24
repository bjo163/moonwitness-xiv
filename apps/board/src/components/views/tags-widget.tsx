import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AddIcon, CloseIcon, TagIcon } from '@moonwitness/ui/icons';
import { client } from '@/lib/client';
import { scopedQueryKey } from '@/lib/query-scope';
import { Button } from '@moonwitness/ui/components/button';
import { Input } from '@moonwitness/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@moonwitness/ui/components/popover';

interface TagItem {
  id: number;
  name: string;
  color?: string;
}

interface TagLinkItem {
  id: number;
  tag_id: number;
  resource_model: string;
  resource_id: number;
  tag?: TagItem;
}

interface TagsWidgetProps {
  model: string;
  recordId: number;
}

export function TagsWidget({ model, recordId }: TagsWidgetProps) {
  const queryClient = useQueryClient();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [creating, setCreating] = useState(false);

  // 1. Query attached tag links with eager-loaded tag relation
  const { data: linksData } = useQuery({
    queryKey: scopedQueryKey(['records', 'base.tag_link', 'for_record', model, recordId]),
    queryFn: () =>
      client.model<TagLinkItem>('base.tag_link').searchRead({
        domain: [
          ['resource_model', '=', model],
          ['resource_id', '=', recordId],
        ],
        with: 'tag',
        limit: 50,
      }),
  });

  // 2. Query all existing tags in system
  const { data: allTagsData } = useQuery({
    queryKey: scopedQueryKey(['records', 'base.tag', 'all']),
    queryFn: () =>
      client.model<TagItem>('base.tag').searchRead({
        limit: 100,
        order: 'name asc',
      }),
    enabled: popoverOpen,
  });

  const links = linksData?.records ?? [];
  const attachedTagIds = new Set(links.map((l) => l.tag?.id ?? l.tag_id));
  const availableTags = (allTagsData?.records ?? []).filter((t) => !attachedTagIds.has(t.id));

  const handleAttachTag = async (tagId: number) => {
    try {
      await client.model('base.tag_link').create({
        tag_id: tagId,
        resource_model: model,
        resource_id: recordId,
      });
      queryClient.invalidateQueries({
        queryKey: ['records', 'base.tag_link'],
      });
      setPopoverOpen(false);
    } catch (err) {
      console.error('Failed to attach tag:', err);
    }
  };

  const handleRemoveLink = async (linkId: number) => {
    try {
      await client.model('base.tag_link').unlink(linkId, { hard: true });
      queryClient.invalidateQueries({
        queryKey: ['records', 'base.tag_link'],
      });
    } catch (err) {
      console.error('Failed to remove tag link:', err);
    }
  };

  const handleCreateAndAttach = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTagName.trim()) return;

    setCreating(true);
    try {
      // 1. Create the tag
      const createdTag = await client.model<TagItem>('base.tag').create({
        name: newTagName.trim(),
        // The tag schema stores a hex color (the --mw-yellow design token).
        color: '#e6ff00',
      });
      // 2. Attach link
      await client.model('base.tag_link').create({
        tag_id: createdTag.id,
        resource_model: model,
        resource_id: recordId,
      });
      queryClient.invalidateQueries({
        queryKey: ['records', 'base.tag_link'],
      });
      queryClient.invalidateQueries({
        queryKey: ['records', 'base.tag'],
      });
      setNewTagName('');
      setPopoverOpen(false);
    } catch (err) {
      console.error('Failed to create tag:', err);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Attached Tag Stickers */}
      {links.map((link, idx) => {
        const tagName = link.tag?.name ?? `#${link.tag_id}`;
        return (
          <span
            key={link.id}
            className="sticker group relative flex items-center gap-1.5 border-2 border-ink bg-paper-raised px-2.5 py-0.5 font-mono text-xs font-bold text-ink shadow-[2px_2px_0_0_var(--ink)]"
            style={{ '--tilt': `${(idx % 3) - 1.2}deg` } as React.CSSProperties}
          >
            <span className="size-2 border border-ink bg-lime" />
            <span>{tagName}</span>
            <Button
              type="button"
              onClick={() => handleRemoveLink(link.id)}
              className="ml-0.5 text-ink-faint hover:text-pink transition-colors"
              title="Remove tag"
            >
              <CloseIcon className="size-3" />
            </Button>
          </span>
        );
      })}

      {/* Add Tag Popover */}
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            className="inline-flex items-center gap-1 border-2 border-dashed border-ink/40 bg-card px-2 py-0.5 font-mono text-xs font-semibold text-ink-faint hover:border-ink hover:text-ink hover:bg-paper-raised transition-colors"
          >
            <AddIcon className="size-3" /> Tag
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-3 space-y-3 font-sans">
          <div className="flex items-center gap-1.5 border-b border-ink/20 pb-2">
            <TagIcon className="size-3.5 text-lime" />
            <span className="font-display text-xs uppercase tracking-wider text-ink">
              Add Record Tag
            </span>
          </div>

          {/* Quick Create Form */}
          <form onSubmit={handleCreateAndAttach} className="flex items-center gap-1.5">
            <Input
              placeholder="New tag..."
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              className="h-7 text-xs border-2 border-ink px-2"
            />
            <Button type="submit" size="xs" disabled={creating || !newTagName.trim()}>
              Add
            </Button>
          </form>

          {/* Available Existing Tags */}
          <div className="space-y-1 max-h-36 overflow-y-auto pt-1 font-mono text-xs">
            {availableTags.length === 0 ? (
              <p className="text-[11px] text-ink-faint text-center py-1">No other tags</p>
            ) : (
              availableTags.map((tag) => (
                <Button
                  key={tag.id}
                  type="button"
                  onClick={() => handleAttachTag(tag.id)}
                  className="w-full flex items-center gap-2 border border-ink/20 bg-paper px-2 py-1 text-left text-xs transition-colors hover:border-ink hover:bg-lime hover:text-on-accent"
                >
                  <span className="size-2 border border-ink bg-lime shrink-0" />
                  <span className="truncate font-bold">{tag.name}</span>
                </Button>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
