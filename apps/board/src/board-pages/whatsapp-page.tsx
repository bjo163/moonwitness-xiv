'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@moonwitness/client';
import {
  AttachmentIcon,
  SendIcon,
  SignalIcon,
  SignalOffIcon,
  SmartphoneIcon,
  UsersIcon,
} from '@moonwitness/ui/icons';
import { toast } from '@moonwitness/ui/components/toast';
import { Button } from '@moonwitness/ui/components/button';
import { Checkbox } from '@moonwitness/ui/components/checkbox';
import { Input } from '@moonwitness/ui/components/input';
import { Skeleton } from '@moonwitness/ui/components/skeleton';
import { Textarea } from '@moonwitness/ui/components/textarea';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { client } from '@/lib/client';
import { scopedQueryKey } from '@/lib/query-scope';
import { formatDateTime } from '@/lib/date-format';
import { MAX_ATTACHMENT_BYTES } from '@moonwitness/types';

type Account = {
  id?: number;
  status: string;
  phone_number?: string | null;
  qr_code?: string | null;
  last_error?: string | null;
  permissions?: {
    manage: boolean;
    manageConversations: boolean;
    createConversation: boolean;
    send: boolean;
    manageMessages: boolean;
  };
};
type Conversation = {
  id: number;
  jid: string;
  name: string;
  is_group: boolean;
  is_archived: boolean;
  is_pinned: boolean;
  assigned_user_id?: number | null;
  assigned_user_name?: string | null;
  assigned_team_id?: number | null;
  assigned_team_name?: string | null;
  work_state?: 'open' | 'closed';
  unread_count: number;
  last_message?: string | null;
  last_message_at?: string | null;
  labels?: ConversationLabel[];
};
type ContactProfile = {
  name: string;
  phone_number: string | null;
  verified_name: string | null;
  status: string | null;
  avatar_available?: boolean;
  picture_id?: string | null;
};
type GroupProfile = {
  name: string;
  topic: string | null;
  participant_count: number | null;
  participants: Array<{
    jid: string;
    phone_number: string | null;
    display_name: string | null;
    is_admin: boolean;
    is_super_admin: boolean;
  }>;
  synced_at: string | null;
  stale: boolean;
};
type ConversationLabel = { id: number; name: string; color: string };
type ConversationAgent = {
  id: number;
  login: string;
  team_id: number | null;
  team_name: string | null;
};
type ConversationTeam = { id: number; name: string };
type QueueFilter = 'all' | 'mine' | 'unassigned';
type WorkStateFilter = 'all' | 'open' | 'closed';
type UploadProgressState = {
  percent: number | null;
  bytesPerSecond: number;
};
type ConversationPage = {
  items: Conversation[];
  nextOffset: number;
  hasMore: boolean;
};

function formatConversationAddress(conversation: Conversation): string {
  const [localPart, domain] = conversation.jid.split('@');
  const identifier = localPart?.split(':')[0]?.trim();
  if (!identifier) return conversation.jid;

  if (conversation.is_group || domain === 'g.us') return `Group ID: ${identifier}`;
  if (domain === 's.whatsapp.net' && /^\d+$/.test(identifier)) return `+${identifier}`;
  if (domain === 'lid') return `WhatsApp ID: ${identifier}`;
  return conversation.jid;
}

function formatTransferRate(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatMediaSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function safeMediaDownloadName(fileName: string | null | undefined): {
  name: string;
  blockedExtension: string | null;
} {
  const original =
    (fileName ?? 'attachment')
      .normalize('NFC')
      .replace(/[\\/\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '_')
      .trim()
      .replace(/[. ]+$/u, '')
      .slice(0, 200) || 'attachment';
  const extension = original.match(/\.([a-z0-9]{1,12})$/iu)?.[1]?.toLowerCase();
  const blocked = new Set([
    'ade',
    'adp',
    'bat',
    'cmd',
    'com',
    'cpl',
    'dll',
    'docm',
    'exe',
    'hta',
    'htm',
    'html',
    'jar',
    'js',
    'jse',
    'lnk',
    'mht',
    'mhtml',
    'msi',
    'msp',
    'ocx',
    'pif',
    'potm',
    'ppam',
    'pps',
    'pptm',
    'ps1',
    'reg',
    'scf',
    'scr',
    'sct',
    'shb',
    'shs',
    'svg',
    'url',
    'vb',
    'vbe',
    'vbs',
    'ws',
    'wsc',
    'wsf',
    'wsh',
    'xlsm',
    'xlam',
    'xll',
    'xsl',
    'xml',
  ]);
  if (extension && blocked.has(extension)) {
    return { name: `${original}.download`, blockedExtension: `.${extension}` };
  }
  return { name: original, blockedExtension: null };
}

type Message = {
  id: number;
  direction: string;
  is_last_read?: boolean;
  is_unread?: boolean;
  content?: string | null;
  status: string;
  retryable?: boolean;
  last_error?: string | null;
  message_type: string;
  provider_type?: string | null;
  media_mime_type?: string | null;
  media_file_name?: string | null;
  media_scan_status?: 'not_applicable' | 'pending' | 'clean' | 'infected';
  sender_jid?: string | null;
  sender_display_name?: string | null;
  reply_to?: {
    id?: number;
    direction?: string;
    content?: string | null;
    message_type?: string;
    provider_type?: string | null;
    media_file_name?: string | null;
    unavailable?: boolean;
  } | null;
  is_forwarded?: boolean;
  is_edited?: boolean;
  is_deleted?: boolean;
  reactions?: Array<{
    emoji: string;
    sender_jid: string | null;
    sender_display_name?: string | null;
    is_from_me: boolean;
    timestamp?: string | null;
  }>;
  create_date: string;
};
type InternalNote = {
  id: number;
  user_id: number;
  author_name: string;
  body: string;
  create_date: string;
};
const reactionEmojis = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉'];
const providerTypeLabels: Record<string, string> = {
  contact: 'Contact card',
  location: 'Location',
  live_location: 'Live location',
  poll: 'Poll',
  call: 'Call event',
  event: 'Event',
  protocol: 'System message',
  view_once: 'View-once media',
};

function messageFallbackLabel(providerType?: string | null): string {
  return providerType ? (providerTypeLabels[providerType] ?? 'Unsupported message type') : '';
}

function summarizeReactions(reactions: Message['reactions'] = []) {
  const summary = new Map<string, { emoji: string; count: number; includesMe: boolean }>();
  for (const reaction of reactions) {
    const current = summary.get(reaction.emoji) ?? {
      emoji: reaction.emoji,
      count: 0,
      includesMe: false,
    };
    current.count++;
    current.includesMe ||= reaction.is_from_me;
    summary.set(reaction.emoji, current);
  }
  return [...summary.values()];
}
type ConversationFilter = 'all' | 'unread' | 'private' | 'groups';
type WhatsAppInboxPreferences = {
  selectedConversationId: number | null;
  selectedLabelId: number | null;
  conversationFilter: ConversationFilter;
  queueFilter: QueueFilter;
  teamId: number | null;
  workStateFilter: WorkStateFilter;
  showArchived: boolean;
  sendOnEnter: boolean;
};
const defaultInboxPreferences: WhatsAppInboxPreferences = {
  selectedConversationId: null,
  selectedLabelId: null,
  conversationFilter: 'all',
  queueFilter: 'all',
  teamId: null,
  workStateFilter: 'open',
  showArchived: false,
  sendOnEnter: true,
};
const statusLabel: Record<string, string> = {
  disconnected: 'Not connected',
  connecting: 'Connecting',
  qr: 'Scan the QR code',
  qr_expired: 'QR code expired',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  error: 'Connection error',
};
const messageStatusLabel: Record<string, string> = {
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  received: 'Received',
  failed: 'Failed',
  unknown: 'Status unknown',
};

export function WhatsappPage() {
  const inboxPreferenceScope = `mw-whatsapp-inbox:${client.currentUser?.id ?? 'anonymous'}:${client.getCompanyId() ?? 'none'}`;
  return <WhatsappInbox key={inboxPreferenceScope} inboxPreferenceScope={inboxPreferenceScope} />;
}

function WhatsappInbox({ inboxPreferenceScope }: { inboxPreferenceScope: string }) {
  const queryClient = useQueryClient();
  const [inboxPreferences, setInboxPreferences] = useState(() =>
    readWhatsAppInboxPreferences(inboxPreferenceScope)
  );
  const {
    selectedConversationId: selected,
    selectedLabelId,
    conversationFilter,
    queueFilter,
    teamId,
    workStateFilter,
    showArchived,
  } = inboxPreferences;
  const setSelected = (selectedConversationId: number | null) => {
    setReplyingTo(null);
    setInboxPreferences((current) => ({ ...current, selectedConversationId }));
  };
  const setConversationFilter = (conversationFilter: ConversationFilter) =>
    setInboxPreferences((current) => ({ ...current, conversationFilter }));
  const setSelectedLabelId = (selectedLabelId: number | null) =>
    setInboxPreferences((current) => ({ ...current, selectedLabelId }));
  const setQueueFilter = (queueFilter: QueueFilter) =>
    setInboxPreferences((current) => ({ ...current, queueFilter }));
  const setTeamId = (teamId: number | null) =>
    setInboxPreferences((current) => ({ ...current, teamId }));
  const setWorkStateFilter = (workStateFilter: WorkStateFilter) =>
    setInboxPreferences((current) => ({ ...current, workStateFilter }));
  const setShowArchived = (showArchived: boolean) =>
    setInboxPreferences((current) => ({ ...current, showArchived }));
  const [newPhone, setNewPhone] = useState('');
  const [phoneCheck, setPhoneCheck] = useState<{
    phone: string;
    is_on_whatsapp: boolean;
  } | null>(null);
  const [checkingPhone, setCheckingPhone] = useState(false);
  const [conversationSearch, setConversationSearch] = useState('');
  const conversationSearchRef = useRef<HTMLInputElement>(null);
  const [mobileConversationOpen, setMobileConversationOpen] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  const [pendingLabelDeleteId, setPendingLabelDeleteId] = useState<number | null>(null);
  const [assignmentPanelOpen, setAssignmentPanelOpen] = useState(false);
  const [debouncedConversationSearch, setDebouncedConversationSearch] = useState('');
  const [updatingConversation, setUpdatingConversation] = useState(false);
  const [startingChat, setStartingChat] = useState(false);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [creatingNote, setCreatingNote] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [forwardingMessage, setForwardingMessage] = useState<Message | null>(null);
  const [reactingTo, setReactingTo] = useState<Message | null>(null);
  const [reacting, setReacting] = useState(false);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [editText, setEditText] = useState('');
  const [revokingMessage, setRevokingMessage] = useState<Message | null>(null);
  const [updatingMessage, setUpdatingMessage] = useState(false);
  const [forwardConversationSearch, setForwardConversationSearch] = useState('');
  const [debouncedForwardConversationSearch, setDebouncedForwardConversationSearch] = useState('');
  const [forwardShowArchived, setForwardShowArchived] = useState(false);
  const [loadingMoreForwardDestinations, setLoadingMoreForwardDestinations] = useState(false);
  const [forwarding, setForwarding] = useState(false);
  const forwardIdempotencyKey = useRef<{
    sourceId: number;
    destinationId: number;
    key: string;
  } | null>(null);
  const loadingMoreConversationsRef = useRef(false);
  const [olderPage, setOlderPage] = useState<{
    conversationId: number;
    messages: Message[];
    nextOffset: number;
    hasMore: boolean;
  } | null>(null);
  const [loadingOlderConversationId, setLoadingOlderConversationId] = useState<number | null>(null);
  const loadingOlderRef = useRef<number | null>(null);
  const activeConversationIdRef = useRef<number | undefined>(undefined);
  const messageContainerRef = useRef<HTMLDivElement | null>(null);
  const latestMessageRef = useRef<{
    conversationId: number | undefined;
    messageId: number | undefined;
  }>({
    conversationId: undefined,
    messageId: undefined,
  });
  const isNearLatestRef = useRef(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const [qr, setQr] = useState<{ code: string; image: string } | null>(null);
  const [clockNow, setClockNow] = useState(0);
  useEffect(() => {
    const updateClock = () => setClockNow(Date.now());
    updateClock();
    const timer = window.setInterval(updateClock, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(inboxPreferenceScope, JSON.stringify(inboxPreferences));
    } catch {
      // The inbox remains usable when browser storage is unavailable.
    }
  }, [inboxPreferenceScope, inboxPreferences]);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedConversationSearch(conversationSearch.trim()),
      250
    );
    return () => window.clearTimeout(timer);
  }, [conversationSearch]);
  useEffect(() => {
    const focusConversationSearch = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"]'))
      ) {
        return;
      }
      const searchInput = conversationSearchRef.current;
      if (!searchInput) return;
      event.preventDefault();
      searchInput.focus();
    };
    window.addEventListener('keydown', focusConversationSearch);
    return () => window.removeEventListener('keydown', focusConversationSearch);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedForwardConversationSearch(forwardConversationSearch.trim()),
      250
    );
    return () => window.clearTimeout(timer);
  }, [forwardConversationSearch]);
  const accountQuery = useQuery({
    queryKey: scopedQueryKey(['whatsapp', 'account']),
    queryFn: async () => (await client.request<{ data: Account }>('/whatsapp/account')).data,
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
  });
  const labelsQuery = useQuery({
    queryKey: scopedQueryKey(['whatsapp', 'labels']),
    queryFn: async () =>
      (await client.request<{ data: ConversationLabel[] }>('/whatsapp/labels')).data,
    enabled: accountQuery.data?.status === 'connected',
  });
  const agentsQuery = useQuery({
    queryKey: scopedQueryKey(['whatsapp', 'agents']),
    queryFn: async () =>
      (
        await client.request<{
          data: { members: ConversationAgent[]; teams: ConversationTeam[] };
        }>('/whatsapp/agents')
      ).data,
    enabled: accountQuery.data?.status === 'connected',
  });
  const effectiveTeamId =
    teamId !== null &&
    agentsQuery.data &&
    !agentsQuery.data.teams.some((team) => team.id === teamId)
      ? null
      : teamId;
  const effectiveSelectedLabelId =
    selectedLabelId !== null &&
    labelsQuery.data &&
    !labelsQuery.data.some((label) => label.id === selectedLabelId)
      ? null
      : selectedLabelId;
  const conversationsQueryKey = scopedQueryKey([
    'whatsapp',
    'conversations',
    debouncedConversationSearch,
    showArchived,
    conversationFilter,
    queueFilter,
    effectiveTeamId,
    workStateFilter,
    effectiveSelectedLabelId,
  ]);
  const conversationsQuery = useQuery({
    queryKey: conversationsQueryKey,
    queryFn: async () => {
      const page = (
        await client.request<{ data: Conversation[] }>(
          `/whatsapp/conversations?limit=50&offset=0&archived=${showArchived}&unread=${conversationFilter === 'unread'}&queue=${queueFilter}&work_state=${workStateFilter}${effectiveTeamId ? `&team_id=${effectiveTeamId}` : ''}${effectiveSelectedLabelId ? `&label_id=${effectiveSelectedLabelId}` : ''}${debouncedConversationSearch ? `&search=${encodeURIComponent(debouncedConversationSearch)}` : ''}`
        )
      ).data;
      const cached = queryClient.getQueryData<ConversationPage>(conversationsQueryKey);
      const pageIds = new Set(page.map((conversation) => conversation.id));
      const preserveCachedConversations =
        queueFilter === 'all' && effectiveTeamId === null && workStateFilter === 'all';
      const cachedItems =
        preserveCachedConversations && cached?.items
          ? cached.items.filter(
              (item) =>
                item.is_archived === showArchived &&
                (conversationFilter !== 'unread' || item.unread_count > 0) &&
                !pageIds.has(item.id)
            )
          : [];
      const items = [...page, ...cachedItems];
      return {
        items,
        nextOffset: Math.max(cached?.nextOffset ?? 0, items.length),
        hasMore: cached?.hasMore ?? page.length === 50,
      } satisfies ConversationPage;
    },
    enabled: accountQuery.data?.status === 'connected',
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
  const forwardDestinationsQueryKey = scopedQueryKey([
    'whatsapp',
    'forward-destinations',
    debouncedForwardConversationSearch,
    forwardShowArchived,
  ]);
  const forwardDestinationsQuery = useQuery({
    queryKey: forwardDestinationsQueryKey,
    queryFn: async () => {
      const page = (
        await client.request<{ data: Conversation[] }>(
          `/whatsapp/conversations?limit=50&offset=0&archived=${forwardShowArchived}&unread=false${debouncedForwardConversationSearch ? `&search=${encodeURIComponent(debouncedForwardConversationSearch)}` : ''}`
        )
      ).data;
      return {
        items: page,
        nextOffset: page.length,
        hasMore: page.length === 50,
      } satisfies ConversationPage;
    },
    enabled: Boolean(forwardingMessage) && accountQuery.data?.status === 'connected',
    refetchInterval: false,
    refetchIntervalInBackground: false,
  });
  const filteredConversations = (conversationsQuery.data?.items ?? []).filter((conversation) => {
    const matchesFilter =
      conversationFilter === 'all' ||
      (conversationFilter === 'unread' && conversation.unread_count > 0) ||
      (conversationFilter === 'groups' && conversation.is_group) ||
      (conversationFilter === 'private' && !conversation.is_group);
    const query = conversationSearch.trim().toLocaleLowerCase();
    const digits = query.replace(/\D/gu, '');
    const matchesSearch =
      !query ||
      (conversationSearch.trim() === debouncedConversationSearch &&
        Boolean(debouncedConversationSearch)) ||
      `${conversation.name} ${conversation.jid}`.toLocaleLowerCase().includes(query) ||
      (digits.length > 0 && conversation.jid.replace(/\D/gu, '').includes(digits));
    const matchesLabel =
      effectiveSelectedLabelId === null ||
      conversation.labels?.some((label) => label.id === effectiveSelectedLabelId);
    const matchesQueue =
      queueFilter === 'all' ||
      (queueFilter === 'mine' && conversation.assigned_user_id === client.currentUser?.id) ||
      (queueFilter === 'unassigned' &&
        !conversation.assigned_user_id &&
        !conversation.assigned_team_id);
    const matchesTeam =
      effectiveTeamId === null || conversation.assigned_team_id === effectiveTeamId;
    const matchesState =
      workStateFilter === 'all' || (conversation.work_state ?? 'open') === workStateFilter;
    return (
      matchesFilter && matchesSearch && matchesLabel && matchesQueue && matchesTeam && matchesState
    );
  });
  const activeConversation =
    filteredConversations.find((item) => item.id === selected) ?? filteredConversations[0];
  const contactProfileQuery = useQuery({
    queryKey: scopedQueryKey(['whatsapp', 'contact', activeConversation?.id]),
    queryFn: async () =>
      (
        await client.request<{ data: ContactProfile }>(
          `/whatsapp/conversations/${activeConversation!.id}/contact`
        )
      ).data,
    enabled:
      accountQuery.data?.status === 'connected' &&
      Boolean(activeConversation && !activeConversation.is_group),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });
  const groupProfileQuery = useQuery({
    queryKey: scopedQueryKey(['whatsapp', 'group-profile', activeConversation?.id]),
    queryFn: async () =>
      (
        await client.request<{ data: GroupProfile }>(
          `/whatsapp/conversations/${activeConversation!.id}/group`
        )
      ).data,
    enabled: accountQuery.data?.status === 'connected' && Boolean(activeConversation?.is_group),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    activeConversationIdRef.current = activeConversation?.id;
  }, [activeConversation?.id]);
  const messagesQuery = useQuery({
    queryKey: scopedQueryKey(['whatsapp', 'messages', activeConversation?.id]),
    queryFn: async () =>
      (
        await client.request<{ data: Message[] }>(
          `/whatsapp/conversations/${activeConversation!.id}/messages?limit=50&offset=0`
        )
      ).data,
    enabled: accountQuery.data?.status === 'connected' && Boolean(activeConversation),
    refetchInterval: 2500,
    refetchIntervalInBackground: false,
  });
  const notesQuery = useQuery({
    queryKey: scopedQueryKey(['whatsapp', 'notes', activeConversation?.id]),
    queryFn: async () =>
      (
        await client.request<{ data: InternalNote[] }>(
          `/whatsapp/conversations/${activeConversation!.id}/notes?limit=50&offset=0`
        )
      ).data,
    enabled: notesOpen && accountQuery.data?.status === 'connected' && Boolean(activeConversation),
    refetchInterval: false,
    refetchIntervalInBackground: false,
  });
  const latestMessageId = messagesQuery.data?.[0]?.id;
  useEffect(() => {
    const conversationId = activeConversation?.id;
    const previous = latestMessageRef.current;
    if (previous.conversationId !== conversationId) {
      latestMessageRef.current = { conversationId, messageId: latestMessageId };
      isNearLatestRef.current = true;
      setHasNewMessages(false);
      if (conversationId !== undefined) {
        window.requestAnimationFrame(() => {
          if (activeConversationIdRef.current === conversationId && messageContainerRef.current) {
            messageContainerRef.current.scrollTop = 0;
          }
        });
      }
      return;
    }
    if (latestMessageId === undefined || latestMessageId === previous.messageId) return;
    latestMessageRef.current.messageId = latestMessageId;
    if (isNearLatestRef.current) {
      messageContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      setHasNewMessages(true);
    }
  }, [activeConversation?.id, latestMessageId]);

  const loadMoreConversations = async () => {
    const current = queryClient.getQueryData<ConversationPage>(conversationsQueryKey);
    if (!current?.hasMore || loadingMoreConversationsRef.current) return;
    loadingMoreConversationsRef.current = true;
    setLoadingMoreConversations(true);
    try {
      const page = (
        await client.request<{ data: Conversation[] }>(
          `/whatsapp/conversations?limit=50&offset=${current.nextOffset}&archived=${showArchived}&unread=${conversationFilter === 'unread'}&queue=${queueFilter}&work_state=${workStateFilter}${effectiveTeamId ? `&team_id=${effectiveTeamId}` : ''}${effectiveSelectedLabelId ? `&label_id=${effectiveSelectedLabelId}` : ''}${debouncedConversationSearch ? `&search=${encodeURIComponent(debouncedConversationSearch)}` : ''}`
        )
      ).data;
      queryClient.setQueryData<ConversationPage>(conversationsQueryKey, (latest) => {
        const currentItems = latest?.items ?? current.items;
        const ids = new Set(currentItems.map((conversation) => conversation.id));
        return {
          items: [...currentItems, ...page.filter((conversation) => !ids.has(conversation.id))],
          nextOffset: current.nextOffset + page.length,
          hasMore: page.length === 50,
        };
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load more conversations');
    } finally {
      loadingMoreConversationsRef.current = false;
      setLoadingMoreConversations(false);
    }
  };

  const loadMoreForwardDestinations = async () => {
    const current = queryClient.getQueryData<ConversationPage>(forwardDestinationsQueryKey);
    if (!current?.hasMore || loadingMoreForwardDestinations) return;
    setLoadingMoreForwardDestinations(true);
    try {
      const page = (
        await client.request<{ data: Conversation[] }>(
          `/whatsapp/conversations?limit=50&offset=${current.nextOffset}&archived=${forwardShowArchived}&unread=false${debouncedForwardConversationSearch ? `&search=${encodeURIComponent(debouncedForwardConversationSearch)}` : ''}`
        )
      ).data;
      queryClient.setQueryData<ConversationPage>(forwardDestinationsQueryKey, (latest) => {
        const latestPage = latest ?? current;
        const ids = new Set(latestPage.items.map((conversation) => conversation.id));
        const uniquePage = page.filter((conversation) => !ids.has(conversation.id));
        return {
          items: [...latestPage.items, ...uniquePage],
          nextOffset: current.nextOffset + page.length,
          hasMore: page.length === 50,
        };
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load more destinations');
    } finally {
      setLoadingMoreForwardDestinations(false);
    }
  };

  const markConversationRead = async () => {
    if (!activeConversation || markingRead) return;
    setMarkingRead(true);
    try {
      await client.request(`/whatsapp/conversations/${activeConversation.id}/read`, {
        method: 'POST',
      });
      await queryClient.invalidateQueries({ queryKey: scopedQueryKey(['whatsapp']) });
      toast.success('Latest message marked as read');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not mark conversation as read');
    } finally {
      setMarkingRead(false);
    }
  };
  const addInternalNote = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeConversation || creatingNote || !noteDraft.trim()) return;
    setCreatingNote(true);
    try {
      await client.request(`/whatsapp/conversations/${activeConversation.id}/notes`, {
        method: 'POST',
        body: { content: noteDraft.trim() },
      });
      setNoteDraft('');
      await queryClient.invalidateQueries({
        queryKey: scopedQueryKey(['whatsapp', 'notes', activeConversation.id]),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Internal note could not be saved');
    } finally {
      setCreatingNote(false);
    }
  };

  const updateConversationArchive = async () => {
    if (!activeConversation || updatingConversation) return;
    setUpdatingConversation(true);
    try {
      const archived = !activeConversation.is_archived;
      await client.request(`/whatsapp/conversations/${activeConversation.id}/archive`, {
        method: 'POST',
        body: { archived },
      });
      queryClient.setQueryData<ConversationPage>(conversationsQueryKey, (current) =>
        current
          ? {
              ...current,
              items: current.items.filter((item) => item.id !== activeConversation.id),
            }
          : current
      );
      setSelected(null);
      await queryClient.invalidateQueries({ queryKey: scopedQueryKey(['whatsapp']) });
      toast.success(
        activeConversation.is_archived ? 'Conversation unarchived' : 'Conversation archived'
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update archive state');
    } finally {
      setUpdatingConversation(false);
    }
  };

  const updateConversationPin = async () => {
    if (!activeConversation || updatingConversation) return;
    setUpdatingConversation(true);
    try {
      const pinned = !activeConversation.is_pinned;
      await client.request(`/whatsapp/conversations/${activeConversation.id}/pin`, {
        method: 'POST',
        body: { pinned },
      });
      queryClient.setQueryData<ConversationPage>(conversationsQueryKey, (current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.id === activeConversation.id ? { ...item, is_pinned: pinned } : item
              ),
            }
          : current
      );
      await queryClient.invalidateQueries({ queryKey: scopedQueryKey(['whatsapp']) });
      toast.success(activeConversation.is_pinned ? 'Conversation unpinned' : 'Conversation pinned');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update pin state');
    } finally {
      setUpdatingConversation(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const code = accountQuery.data?.qr_code;
    if (!code) return;
    if (code.startsWith('data:image/')) return;
    void import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(code, { width: 256, margin: 1 }))
      .then((image) => {
        if (!cancelled) setQr({ code, image });
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [accountQuery.data?.qr_code]);

  const connect = async () => {
    try {
      await client.request('/whatsapp/connect', { method: 'POST', body: {} });
      await queryClient.invalidateQueries({ queryKey: scopedQueryKey(['whatsapp']) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start WhatsApp connection');
    }
  };
  const forwardTo = async (destination: Conversation) => {
    if (!forwardingMessage || forwarding) return;
    if (
      forwardIdempotencyKey.current?.sourceId !== forwardingMessage.id ||
      forwardIdempotencyKey.current?.destinationId !== destination.id
    ) {
      forwardIdempotencyKey.current = {
        sourceId: forwardingMessage.id,
        destinationId: destination.id,
        key: crypto.randomUUID(),
      };
    }
    setForwarding(true);
    try {
      await client.request(`/whatsapp/messages/${forwardingMessage.id}/forward`, {
        method: 'POST',
        headers: { 'Idempotency-Key': forwardIdempotencyKey.current.key },
        body: { conversation_id: destination.id },
      });
      forwardIdempotencyKey.current = null;
      setForwardingMessage(null);
      await queryClient.invalidateQueries({ queryKey: scopedQueryKey(['whatsapp']) });
      toast.success('Forward queued');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Message could not be forwarded');
    } finally {
      setForwarding(false);
    }
  };
  const reactToMessage = async (message: Message, emoji: string) => {
    if (reacting) return;
    setReacting(true);
    try {
      await client.request(`/whatsapp/messages/${message.id}/reaction`, {
        method: 'POST',
        body: { emoji },
      });
      setReactingTo(null);
      await queryClient.invalidateQueries({
        queryKey: scopedQueryKey(['whatsapp', 'messages', activeConversation?.id]),
      });
      toast.success('Reaction sent');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not send reaction');
    } finally {
      setReacting(false);
    }
  };
  const editMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingMessage || updatingMessage) return;
    setUpdatingMessage(true);
    try {
      await client.request(`/whatsapp/messages/${editingMessage.id}/edit`, {
        method: 'POST',
        body: { content: editText },
      });
      setEditingMessage(null);
      await queryClient.invalidateQueries({ queryKey: scopedQueryKey(['whatsapp']) });
      toast.success('Message edited');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not edit message');
    } finally {
      setUpdatingMessage(false);
    }
  };
  const revokeMessage = async () => {
    if (!revokingMessage || updatingMessage) return;
    setUpdatingMessage(true);
    try {
      await client.request(`/whatsapp/messages/${revokingMessage.id}/revoke`, { method: 'POST' });
      setRevokingMessage(null);
      await queryClient.invalidateQueries({ queryKey: scopedQueryKey(['whatsapp']) });
      toast.success('Message deleted for everyone');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete message');
    } finally {
      setUpdatingMessage(false);
    }
  };
  const disconnect = async () => {
    try {
      await client.request('/whatsapp/disconnect', { method: 'POST', body: {} });
      await queryClient.invalidateQueries({ queryKey: scopedQueryKey(['whatsapp']) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not disconnect WhatsApp');
    }
  };
  const startChat = async (event: FormEvent) => {
    event.preventDefault();
    if (startingChat) return;
    const phone = newPhone.replace(/[\s().-]/gu, '').replace(/^\+/u, '');
    if (phoneCheck?.phone !== `+${phone}` || !phoneCheck.is_on_whatsapp) {
      toast.error('Check that this number is on WhatsApp before starting a chat');
      return;
    }
    setStartingChat(true);
    try {
      const response = await client.request<{ data: Conversation }>('/whatsapp/conversations', {
        method: 'POST',
        body: { phone: `+${phone}` },
      });
      setNewPhone('');
      await queryClient.invalidateQueries({
        queryKey: scopedQueryKey(['whatsapp', 'conversations']),
      });
      setSelected(response.data.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start conversation');
    } finally {
      setStartingChat(false);
    }
  };
  const checkPhone = async () => {
    if (checkingPhone) return;
    setCheckingPhone(true);
    setPhoneCheck(null);
    try {
      const response = await client.request<{
        data: { phone: string; is_on_whatsapp: boolean };
      }>('/whatsapp/contacts/check', { method: 'POST', body: { phone: newPhone } });
      setPhoneCheck(response.data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not check this number');
    } finally {
      setCheckingPhone(false);
    }
  };

  const createLabel = async (event: FormEvent) => {
    event.preventDefault();
    const name = newLabelName.trim();
    if (!name) return;
    try {
      await client.request('/whatsapp/labels', {
        method: 'POST',
        body: { name, color: '#f1d340' },
      });
      setNewLabelName('');
      await queryClient.invalidateQueries({ queryKey: scopedQueryKey(['whatsapp', 'labels']) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create label');
    }
  };

  const toggleConversationLabel = async (labelId: number) => {
    if (!activeConversation || updatingConversation) return;
    const current = activeConversation.labels ?? [];
    const labelIds = current.some((label) => label.id === labelId)
      ? current.filter((label) => label.id !== labelId).map((label) => label.id)
      : [...current.map((label) => label.id), labelId];
    setUpdatingConversation(true);
    try {
      await client.request(`/whatsapp/conversations/${activeConversation.id}/labels`, {
        method: 'PUT',
        body: { label_ids: labelIds },
      });
      await queryClient.invalidateQueries({
        queryKey: scopedQueryKey(['whatsapp', 'conversations']),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update conversation labels');
    } finally {
      setUpdatingConversation(false);
    }
  };

  const updateConversationAssignment = async (
    assignedUserId: number | null,
    assignedTeamId: number | null
  ) => {
    if (!activeConversation || updatingConversation) return;
    setUpdatingConversation(true);
    try {
      await client.request(`/whatsapp/conversations/${activeConversation.id}/assignment`, {
        method: 'PUT',
        body: { assigned_user_id: assignedUserId, assigned_team_id: assignedTeamId },
      });
      setAssignmentPanelOpen(false);
      await queryClient.invalidateQueries({
        queryKey: scopedQueryKey(['whatsapp', 'conversations']),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update assignment');
    } finally {
      setUpdatingConversation(false);
    }
  };

  const updateConversationWorkState = async () => {
    if (!activeConversation || updatingConversation) return;
    const workState = activeConversation.work_state === 'closed' ? 'open' : 'closed';
    setUpdatingConversation(true);
    try {
      await client.request(`/whatsapp/conversations/${activeConversation.id}/state`, {
        method: 'PUT',
        body: { work_state: workState },
      });
      await queryClient.invalidateQueries({
        queryKey: scopedQueryKey(['whatsapp', 'conversations']),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update conversation state');
    } finally {
      setUpdatingConversation(false);
    }
  };

  const deleteLabel = async (label: ConversationLabel) => {
    try {
      await client.request(`/whatsapp/labels/${label.id}`, { method: 'DELETE' });
      setPendingLabelDeleteId(null);
      if (selectedLabelId === label.id) setSelectedLabelId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: scopedQueryKey(['whatsapp', 'labels']) }),
        queryClient.invalidateQueries({ queryKey: scopedQueryKey(['whatsapp', 'conversations']) }),
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete label');
    }
  };

  const account = accountQuery.data;
  const status = account?.status ?? 'disconnected';
  const connected = status === 'connected';
  const canManage = account?.permissions?.manage ?? false;
  const canCreateConversation = account?.permissions?.createConversation ?? false;
  const canManageConversations = account?.permissions?.manageConversations ?? canManage;
  const canSend = account?.permissions?.send ?? false;
  const canManageMessages = account?.permissions?.manageMessages ?? false;
  const statusIcon = connected ? (
    <SignalIcon className="size-4" />
  ) : (
    <SignalOffIcon className="size-4" />
  );
  const currentOlderPage = olderPage?.conversationId === activeConversation?.id ? olderPage : null;
  const olderMessages = currentOlderPage?.messages ?? [];
  const olderMessageOffset = currentOlderPage?.nextOffset ?? messagesQuery.data?.length ?? 50;
  const hasOlderMessages = currentOlderPage?.hasMore ?? messagesQuery.data?.length === 50;
  const loadingOlderMessages = loadingOlderConversationId === activeConversation?.id;
  const messageList = Array.from(
    new Map(
      [...(messagesQuery.data ?? []), ...olderMessages].map((message) => [message.id, message])
    ).values()
  );
  const readCursorIndex = messageList.findIndex((message) => message.is_last_read);
  const oldestUnreadIndex = messageList.reduce(
    (oldestIndex, message, index) => (message.is_unread ? index : oldestIndex),
    -1
  );
  const newMessagesDividerIndex =
    readCursorIndex >= 0 ? readCursorIndex : oldestUnreadIndex >= 0 ? oldestUnreadIndex + 1 : -1;
  const loadOlderMessages = async () => {
    if (!activeConversation || !hasOlderMessages) return;
    const requestedConversationId = activeConversation.id;
    if (loadingOlderRef.current === requestedConversationId) return;
    loadingOlderRef.current = requestedConversationId;
    setLoadingOlderConversationId(requestedConversationId);
    try {
      const page = (
        await client.request<{ data: Message[] }>(
          `/whatsapp/conversations/${requestedConversationId}/messages?limit=50&offset=${olderMessageOffset}`
        )
      ).data;
      if (activeConversationIdRef.current !== requestedConversationId) return;
      setOlderPage((current) => {
        const currentMessages =
          current?.conversationId === requestedConversationId ? current.messages : [];
        const byId = new Map(currentMessages.map((message) => [message.id, message]));
        for (const message of page) byId.set(message.id, message);
        return {
          conversationId: requestedConversationId,
          messages: [...byId.values()],
          nextOffset: olderMessageOffset + page.length,
          hasMore: page.length === 50,
        };
      });
    } catch (error) {
      if (activeConversationIdRef.current === requestedConversationId) {
        toast.error(error instanceof Error ? error.message : 'Could not load older messages');
      }
    } finally {
      if (loadingOlderRef.current === requestedConversationId) {
        loadingOlderRef.current = null;
        setLoadingOlderConversationId((current) =>
          current === requestedConversationId ? null : current
        );
      }
    }
  };
  const jumpToQuotedMessage = async (message: Message) => {
    const targetId = message.reply_to?.id;
    const conversationId = activeConversation?.id;
    if (!targetId || !conversationId) return;
    if (!document.getElementById(`whatsapp-message-${targetId}`)) {
      if (loadingOlderRef.current === conversationId) return;
      loadingOlderRef.current = conversationId;
      setLoadingOlderConversationId(conversationId);
      let offset = olderMessageOffset;
      let hasMore = hasOlderMessages;
      const loaded = [...olderMessages];
      try {
        while (hasMore && offset < 5_000 && activeConversationIdRef.current === conversationId) {
          const page = (
            await client.request<{ data: Message[] }>(
              `/whatsapp/conversations/${conversationId}/messages?limit=50&offset=${offset}`
            )
          ).data;
          loaded.push(...page);
          offset += page.length;
          hasMore = page.length === 50;
          if (page.some((item) => item.id === targetId)) break;
        }
        setOlderPage((current) => {
          const existing = current?.conversationId === conversationId ? current.messages : [];
          const byId = new Map([...existing, ...loaded].map((item) => [item.id, item]));
          return { conversationId, messages: [...byId.values()], nextOffset: offset, hasMore };
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not load the quoted message');
        return;
      } finally {
        loadingOlderRef.current = null;
        setLoadingOlderConversationId((current) => (current === conversationId ? null : current));
      }
      if (!loaded.some((item) => item.id === targetId)) {
        toast.error('Quoted message is outside the available history');
        return;
      }
    }
    window.requestAnimationFrame(() => {
      const element = document.getElementById(`whatsapp-message-${targetId}`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element?.focus({ preventScroll: true });
    });
  };
  const qrImage = account?.qr_code?.startsWith('data:image/')
    ? account.qr_code
    : qr && qr.code === account?.qr_code
      ? qr.image
      : null;
  const lastInboxSyncLabel = conversationsQuery.dataUpdatedAt
    ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
        new Date(conversationsQuery.dataUpdatedAt)
      )
    : null;
  const retryWhatsAppData = () => {
    const retries: Promise<unknown>[] = [accountQuery.refetch(), conversationsQuery.refetch()];
    if (connected && activeConversation) retries.push(messagesQuery.refetch());
    void Promise.all(retries);
  };

  return (
    <main className="mx-auto flex min-h-full w-full max-w-7xl flex-col gap-5 p-4 md:p-8">
      <Breadcrumbs items={[{ label: 'WhatsApp' }]} />
      {forwardingMessage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="whatsapp-forward-title"
            className="w-full max-w-md border-2 border-ink bg-cream p-5 shadow-[6px_6px_0_#171717]"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="whatsapp-forward-title" className="font-display text-xl uppercase">
                  Forward message
                </h2>
                <p className="mt-1 line-clamp-2 text-sm text-ink-faint">
                  {forwardingMessage.content || `[${forwardingMessage.message_type}]`}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={forwarding}
                onClick={() => setForwardingMessage(null)}
              >
                Cancel
              </Button>
            </div>
            <div className="mt-4 space-y-3">
              <Input
                aria-label="Search forward destinations"
                placeholder="Search chats and groups"
                value={forwardConversationSearch}
                onChange={(event) => setForwardConversationSearch(event.target.value)}
              />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={forwardShowArchived}
                  onChange={(event) => setForwardShowArchived(event.target.checked)}
                  aria-label="Include archived conversations"
                />
                Include archived conversations
              </label>
              {forwardDestinationsQuery.isError && (
                <div role="alert" className="flex items-center justify-between gap-3 text-sm">
                  <span>Destinations could not be loaded.</span>
                  <Button
                    type="button"
                    variant="link"
                    onClick={() => void forwardDestinationsQuery.refetch()}
                  >
                    Retry
                  </Button>
                </div>
              )}
              <div className="max-h-72 space-y-2 overflow-y-auto" aria-label="Forward destinations">
                {(forwardDestinationsQuery.data?.items ?? []).map((conversation) => (
                  <Button
                    key={conversation.id}
                    type="button"
                    variant="outline"
                    className="w-full justify-start text-left"
                    disabled={forwarding}
                    aria-label={`Forward to ${conversation.name}`}
                    onClick={() => void forwardTo(conversation)}
                  >
                    {conversation.name}
                    {conversation.is_group ? ' · Group' : ''}
                  </Button>
                ))}
                {forwardDestinationsQuery.isLoading && <Skeleton className="h-10 w-full" />}
                {!forwardDestinationsQuery.isLoading &&
                  !forwardDestinationsQuery.data?.items.length && (
                    <p className="p-3 text-sm text-ink-faint">No matching conversations.</p>
                  )}
                {forwardDestinationsQuery.data?.hasMore && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={loadingMoreForwardDestinations}
                    onClick={() => void loadMoreForwardDestinations()}
                  >
                    {loadingMoreForwardDestinations ? 'Loading…' : 'Load more destinations'}
                  </Button>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
      {reactingTo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="whatsapp-reaction-title"
            className="w-full max-w-sm border-2 border-ink bg-cream p-5 shadow-[6px_6px_0_#171717]"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="whatsapp-reaction-title" className="font-display text-xl uppercase">
                  React to message
                </h2>
                <p className="mt-1 line-clamp-2 text-sm text-ink-faint">
                  {reactingTo.content || `[${reactingTo.message_type}]`}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={reacting}
                onClick={() => setReactingTo(null)}
              >
                Cancel
              </Button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Choose a reaction">
              {reactionEmojis.map((emoji) => (
                <Button
                  key={emoji}
                  type="button"
                  variant="outline"
                  className="min-w-11 text-xl"
                  aria-label={`React with ${emoji}`}
                  disabled={reacting}
                  onClick={() => void reactToMessage(reactingTo, emoji)}
                >
                  {emoji}
                </Button>
              ))}
            </div>
          </section>
        </div>
      )}
      {editingMessage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4">
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="whatsapp-edit-title"
            onSubmit={(event) => void editMessage(event)}
            className="w-full max-w-lg border-2 border-ink bg-cream p-5 shadow-[6px_6px_0_#171717]"
          >
            <h2 id="whatsapp-edit-title" className="font-display text-xl uppercase">
              Edit message
            </h2>
            <Textarea
              aria-label="Edited message text"
              value={editText}
              onChange={(event) => setEditText(event.target.value)}
              maxLength={8000}
              required
              autoFocus
            />
            <p className="mt-2 text-xs text-ink-faint">
              WhatsApp only allows editing recent text messages, usually within 15 minutes.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={updatingMessage}
                onClick={() => setEditingMessage(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={updatingMessage || !editText.trim()}>
                {updatingMessage ? 'Saving…' : 'Save edit'}
              </Button>
            </div>
          </form>
        </div>
      )}
      {revokingMessage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4">
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="whatsapp-revoke-title"
            className="w-full max-w-md border-2 border-ink bg-cream p-5 shadow-[6px_6px_0_#171717]"
          >
            <h2 id="whatsapp-revoke-title" className="font-display text-xl uppercase">
              Delete for everyone?
            </h2>
            <p className="mt-2 text-sm">
              WhatsApp will try to remove this message for everyone in the conversation.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={updatingMessage}
                onClick={() => setRevokingMessage(null)}
              >
                Cancel
              </Button>
              <Button type="button" disabled={updatingMessage} onClick={() => void revokeMessage()}>
                {updatingMessage ? 'Deleting…' : 'Delete message'}
              </Button>
            </div>
          </section>
        </div>
      )}
      {(accountQuery.isError || conversationsQuery.isError || messagesQuery.isError) && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 border-2 border-ink bg-pink p-3 text-sm"
        >
          <p>
            WhatsApp data could not be refreshed.
            {conversationsQuery.data && lastInboxSyncLabel
              ? ` Showing inbox data last updated at ${lastInboxSyncLabel}.`
              : ' No inbox data is available yet.'}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              accountQuery.isFetching || conversationsQuery.isFetching || messagesQuery.isFetching
            }
            onClick={retryWhatsAppData}
          >
            Retry
          </Button>
        </div>
      )}
      <header className="flex flex-wrap items-center justify-between gap-4 border-2 border-ink bg-paper p-5 shadow-[4px_4px_0_0_var(--ink)]">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
            Company inbox
          </p>
          <h1 className="font-display text-3xl uppercase">WhatsApp</h1>
          <p className="mt-1 flex items-center gap-2 text-sm">
            {statusIcon}
            <span>{statusLabel[status] ?? status}</span>
            {account?.phone_number && <span className="font-mono">+{account.phone_number}</span>}
          </p>
          {account?.last_error && <p className="mt-2 text-sm text-red-700">{account.last_error}</p>}
        </div>
        {!canManage ? (
          <span className="text-sm text-ink-faint">View-only WhatsApp access</span>
        ) : ['connected', 'connecting', 'qr', 'reconnecting'].includes(status) ? (
          <Button type="button" variant="outline" onClick={disconnect}>
            {connected ? 'Disconnect' : 'Cancel connection'}
          </Button>
        ) : (
          <Button
            type="button"
            onClick={connect}
            disabled={['connecting', 'qr', 'reconnecting'].includes(status)}
          >
            <SmartphoneIcon className="mr-2 size-4" />
            {status === 'qr_expired' ? 'Refresh QR code' : 'Connect WhatsApp'}
          </Button>
        )}
      </header>
      {status === 'qr' && (
        <section className="flex flex-col items-center border-2 border-ink bg-white p-6 text-center shadow-[4px_4px_0_0_var(--ink)]">
          <h2 className="font-display text-xl uppercase">Scan with WhatsApp</h2>
          <p className="mt-1 text-sm">Open Linked devices on your phone and scan this code.</p>
          {qrImage ? (
            <img
              src={qrImage}
              alt="WhatsApp connection QR code"
              className="mt-4 h-auto w-64 max-w-full"
            />
          ) : (
            <Skeleton className="mt-4 size-64" />
          )}
        </section>
      )}
      {connected && (
        <section className="grid min-h-[60vh] flex-1 overflow-hidden border-2 border-ink bg-paper shadow-[4px_4px_0_0_var(--ink)] md:grid-cols-[minmax(240px,0.38fr)_1fr]">
          <aside
            aria-label="Conversation inbox"
            className={`${mobileConversationOpen ? 'hidden' : 'block'} border-b-2 border-ink md:block md:border-b-0 md:border-r-2`}
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              const target = event.target;
              if (!(target instanceof HTMLElement)) return;
              const current = target.closest<HTMLButtonElement>('[data-wa-conversation]');
              if (!current) return;
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-wa-conversation]')
              );
              const currentIndex = buttons.indexOf(current);
              if (currentIndex < 0 || buttons.length < 2) return;
              const nextIndex =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                      buttons.length;
              event.preventDefault();
              buttons[nextIndex]?.focus();
            }}
          >
            <div className="border-b-2 border-ink p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-lg uppercase">Conversations</h2>
                {lastInboxSyncLabel && (
                  <p role="status" className="font-mono text-[10px] text-ink-faint">
                    Last synced {lastInboxSyncLabel}
                  </p>
                )}
              </div>
              <Input
                ref={conversationSearchRef}
                aria-label="Search conversations by name, number, or message"
                aria-describedby="whatsapp-search-shortcut-help"
                aria-keyshortcuts="/"
                className="mt-3"
                placeholder="Search name, number, or message"
                value={conversationSearch}
                onChange={(event) => setConversationSearch(event.target.value)}
              />
              <p id="whatsapp-search-shortcut-help" className="mt-1 text-xs text-ink-faint">
                Press / to focus search. In the conversation list, use ↑/↓ to move and Home/End to
                jump.
              </p>
              <div className="mt-2 flex flex-wrap gap-2" aria-label="Conversation filters">
                {(['all', 'unread', 'private', 'groups'] as const).map((filter) => (
                  <Button
                    key={filter}
                    type="button"
                    size="sm"
                    variant={conversationFilter === filter ? 'default' : 'outline'}
                    aria-pressed={conversationFilter === filter}
                    onClick={() => setConversationFilter(filter)}
                  >
                    {filter === 'all'
                      ? 'All'
                      : filter === 'unread'
                        ? 'Unread'
                        : filter === 'private'
                          ? 'Private'
                          : 'Groups'}
                  </Button>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-2" aria-label="Agent queue filter">
                {(['all', 'mine', 'unassigned'] as const).map((filter) => (
                  <Button
                    key={filter}
                    type="button"
                    size="sm"
                    variant={queueFilter === filter ? 'default' : 'outline'}
                    aria-pressed={queueFilter === filter}
                    onClick={() => setQueueFilter(filter)}
                  >
                    {filter === 'all' ? 'Queue: All' : filter === 'mine' ? 'Mine' : 'Unassigned'}
                  </Button>
                ))}
              </div>
              <div
                className="mt-2 flex flex-wrap gap-2"
                aria-label="Conversation work state filter"
              >
                {(['open', 'closed', 'all'] as const).map((state) => (
                  <Button
                    key={state}
                    type="button"
                    size="sm"
                    variant={workStateFilter === state ? 'default' : 'outline'}
                    aria-pressed={workStateFilter === state}
                    onClick={() => setWorkStateFilter(state)}
                  >
                    {state === 'all' ? 'All states' : state === 'open' ? 'Open' : 'Closed'}
                  </Button>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-2" aria-label="Team queue filter">
                <Button
                  type="button"
                  size="sm"
                  variant={effectiveTeamId === null ? 'default' : 'outline'}
                  aria-pressed={effectiveTeamId === null}
                  onClick={() => setTeamId(null)}
                >
                  All teams
                </Button>
                {(agentsQuery.data?.teams ?? []).map((team) => (
                  <Button
                    key={team.id}
                    type="button"
                    size="sm"
                    variant={effectiveTeamId === team.id ? 'default' : 'outline'}
                    aria-pressed={effectiveTeamId === team.id}
                    onClick={() => setTeamId(team.id)}
                  >
                    {team.name}
                  </Button>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-2" aria-label="Filter by conversation label">
                <Button
                  type="button"
                  size="sm"
                  variant={effectiveSelectedLabelId === null ? 'default' : 'outline'}
                  aria-pressed={effectiveSelectedLabelId === null}
                  onClick={() => setSelectedLabelId(null)}
                >
                  All labels
                </Button>
                {(labelsQuery.data ?? []).map((label) => (
                  <div key={label.id} className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={effectiveSelectedLabelId === label.id ? 'default' : 'outline'}
                      aria-pressed={effectiveSelectedLabelId === label.id}
                      onClick={() => setSelectedLabelId(label.id)}
                      style={{ borderColor: label.color }}
                    >
                      {label.name}
                    </Button>
                    {canManageConversations &&
                      (pendingLabelDeleteId === label.id ? (
                        <span className="flex items-center gap-1 text-xs">
                          <span>Delete?</span>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            aria-label={`Confirm delete label ${label.name}`}
                            onClick={() => void deleteLabel(label)}
                          >
                            Yes
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label="Cancel label deletion"
                            onClick={() => setPendingLabelDeleteId(null)}
                          >
                            No
                          </Button>
                        </span>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`Delete label ${label.name}`}
                          onClick={() => setPendingLabelDeleteId(label.id)}
                        >
                          ×
                        </Button>
                      ))}
                  </div>
                ))}
              </div>
              {labelsQuery.isError && (
                <div className="mt-2 flex items-center gap-2 text-xs" role="alert">
                  <span>Conversation labels could not be loaded.</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={labelsQuery.isFetching}
                    onClick={() => void labelsQuery.refetch()}
                  >
                    Retry labels
                  </Button>
                </div>
              )}
              {canManageConversations && (
                <form onSubmit={createLabel} className="mt-2 flex gap-2">
                  <Input
                    aria-label="New conversation label"
                    placeholder="New label"
                    maxLength={40}
                    value={newLabelName}
                    onChange={(event) => setNewLabelName(event.target.value)}
                  />
                  <Button type="submit" disabled={!newLabelName.trim()}>
                    Add label
                  </Button>
                </form>
              )}
              <div className="mt-2 flex gap-2" aria-label="Archive filter">
                <Button
                  type="button"
                  size="sm"
                  variant={!showArchived ? 'default' : 'outline'}
                  aria-pressed={!showArchived}
                  onClick={() => setShowArchived(false)}
                >
                  Active
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={showArchived ? 'default' : 'outline'}
                  aria-pressed={showArchived}
                  onClick={() => setShowArchived(true)}
                >
                  Archived
                </Button>
              </div>
              {canCreateConversation && (
                <form onSubmit={startChat} className="mt-3 space-y-2">
                  <div className="flex gap-2">
                    <Input
                      aria-label="Phone number with country code"
                      placeholder="+6281234567890"
                      value={newPhone}
                      onChange={(event) => {
                        setNewPhone(event.target.value);
                        setPhoneCheck(null);
                      }}
                      disabled={startingChat || checkingPhone}
                      inputMode="tel"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={startingChat || checkingPhone || !newPhone.trim()}
                      onClick={() => void checkPhone()}
                    >
                      {checkingPhone ? 'Checking…' : 'Check number'}
                    </Button>
                  </div>
                  {phoneCheck && (
                    <p
                      role="status"
                      aria-live="polite"
                      className={`text-xs ${phoneCheck.is_on_whatsapp ? 'text-green-800' : 'text-ink-faint'}`}
                    >
                      {phoneCheck.is_on_whatsapp
                        ? `${phoneCheck.phone} is on WhatsApp`
                        : `${phoneCheck.phone} is not on WhatsApp`}
                    </p>
                  )}
                  <Button
                    type="submit"
                    disabled={
                      startingChat ||
                      checkingPhone ||
                      !newPhone.trim() ||
                      phoneCheck?.is_on_whatsapp !== true
                    }
                  >
                    New chat
                  </Button>
                </form>
              )}
            </div>
            {conversationsQuery.isLoading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
              </div>
            ) : conversationsQuery.isError && !conversationsQuery.data ? (
              <div className="space-y-3 p-4" role="alert">
                <p className="text-sm">Conversations could not be loaded.</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={conversationsQuery.isFetching}
                  onClick={() => void conversationsQuery.refetch()}
                >
                  Retry inbox
                </Button>
              </div>
            ) : filteredConversations.length ? (
              filteredConversations.map((conversation) => (
                <Button
                  key={conversation.id}
                  type="button"
                  data-wa-conversation
                  onClick={() => {
                    setSelected(conversation.id);
                    setMobileConversationOpen(true);
                  }}
                  variant="ghost"
                  className={`h-auto w-full justify-start border-b border-ink/20 p-4 text-left hover:bg-pink/20 ${activeConversation?.id === conversation.id ? 'bg-pink/30' : ''}`}
                >
                  <span className="flex items-center gap-2 font-semibold">
                    {conversation.is_group && <UsersIcon className="size-4" />}
                    {conversation.name}
                    {conversation.is_pinned && <span className="text-xs">Pinned</span>}
                    {conversation.unread_count > 0 && (
                      <span className="ml-auto rounded-full bg-pink px-2 text-xs">
                        {conversation.unread_count}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-sm text-ink-faint">
                    {conversation.last_message}
                  </span>
                  {conversation.labels?.length ? (
                    <span className="flex flex-wrap gap-1" aria-label="Conversation labels">
                      {conversation.labels.map((label) => (
                        <span
                          key={label.id}
                          className="rounded border px-1.5 py-0.5 text-[10px]"
                          style={{ borderColor: label.color }}
                        >
                          {label.name}
                        </span>
                      ))}
                    </span>
                  ) : null}
                  {(conversation.assigned_user_name ||
                    conversation.assigned_team_name ||
                    conversation.work_state === 'closed') && (
                    <span className="flex flex-wrap gap-2 text-[10px] text-ink-faint">
                      {conversation.assigned_user_name && (
                        <span>Assigned to {conversation.assigned_user_name}</span>
                      )}
                      {conversation.assigned_team_name && (
                        <span>Team {conversation.assigned_team_name}</span>
                      )}
                      {conversation.work_state === 'closed' && <span>Closed</span>}
                    </span>
                  )}
                </Button>
              ))
            ) : (
              <p className="p-4 text-sm text-ink-faint">
                {conversationsQuery.data?.items.length
                  ? 'No conversations match this search or filter.'
                  : 'No conversations yet.'}
              </p>
            )}
            {conversationsQuery.data?.hasMore && (
              <Button
                type="button"
                variant="link"
                className="mx-auto my-2"
                disabled={loadingMoreConversations}
                onClick={() => void loadMoreConversations()}
              >
                {loadingMoreConversations ? 'Loading conversations…' : 'Load more conversations'}
              </Button>
            )}
          </aside>
          <div
            className={`${mobileConversationOpen ? 'flex' : 'hidden md:flex'} min-w-0 h-[70vh] min-h-[55vh] max-h-[calc(100dvh-8rem)] flex-col`}
          >
            <div className="border-b-2 border-ink p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  {activeConversation && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="shrink-0 md:hidden"
                      onClick={() => setMobileConversationOpen(false)}
                    >
                      Back to conversations
                    </Button>
                  )}
                  <div className="min-w-0">
                    <h2 className="font-display text-lg uppercase">
                      {activeConversation?.name ?? 'Select a conversation'}
                    </h2>
                    {activeConversation && (
                      <p className="break-all text-xs text-ink-faint">
                        {formatConversationAddress(activeConversation)}
                      </p>
                    )}
                    {activeConversation && !activeConversation.is_group && (
                      <ContactProfileSummary
                        conversationId={activeConversation.id}
                        profile={contactProfileQuery.data}
                        loading={contactProfileQuery.isLoading}
                        failed={contactProfileQuery.isError}
                        refreshing={contactProfileQuery.isFetching}
                        onRefresh={() => void contactProfileQuery.refetch()}
                      />
                    )}
                    {activeConversation?.is_group && (
                      <GroupProfileSummary
                        profile={groupProfileQuery.data}
                        loading={groupProfileQuery.isLoading}
                        failed={groupProfileQuery.isError}
                        onRefresh={() => void groupProfileQuery.refetch()}
                      />
                    )}
                  </div>
                </div>
                {activeConversation && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={notesOpen ? 'default' : 'outline'}
                      aria-expanded={notesOpen}
                      aria-controls="whatsapp-internal-notes"
                      onClick={() => setNotesOpen((open) => !open)}
                    >
                      Internal notes ({notesQuery.data?.length ?? 0})
                    </Button>
                    {canManageConversations && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant={assignmentPanelOpen ? 'default' : 'outline'}
                          aria-expanded={assignmentPanelOpen}
                          aria-controls="whatsapp-assignment-panel"
                          onClick={() => setAssignmentPanelOpen((open) => !open)}
                        >
                          Assign chat
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={updatingConversation}
                          onClick={() => void updateConversationWorkState()}
                        >
                          {activeConversation.work_state === 'closed'
                            ? 'Reopen chat'
                            : 'Close chat'}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={updatingConversation}
                          onClick={() => void updateConversationPin()}
                        >
                          {activeConversation.is_pinned ? 'Unpin chat' : 'Pin chat'}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={updatingConversation}
                          onClick={() => void updateConversationArchive()}
                        >
                          {activeConversation.is_archived ? 'Unarchive chat' : 'Archive chat'}
                        </Button>
                      </>
                    )}
                  </div>
                )}
                {activeConversation && assignmentPanelOpen && canManageConversations && (
                  <section
                    id="whatsapp-assignment-panel"
                    className="w-full border border-ink/30 p-3"
                    aria-label="Assign conversation"
                  >
                    <p className="mb-2 text-xs text-ink-faint">
                      {activeConversation.assigned_user_name
                        ? `Assigned to ${activeConversation.assigned_user_name}`
                        : activeConversation.assigned_team_name
                          ? `Queued for ${activeConversation.assigned_team_name}`
                          : 'No agent or team assigned'}
                    </p>
                    {agentsQuery.isLoading ? (
                      <p role="status" className="text-sm">
                        Loading agents…
                      </p>
                    ) : agentsQuery.isError ? (
                      <div role="alert" className="flex items-center gap-2 text-sm">
                        <span>Agents could not be loaded.</span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={agentsQuery.isFetching}
                          onClick={() => void agentsQuery.refetch()}
                        >
                          Retry agents
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-2" aria-label="Assign to agent">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={updatingConversation}
                            onClick={() => void updateConversationAssignment(null, null)}
                          >
                            Unassign
                          </Button>
                          {(agentsQuery.data?.members ?? []).map((agent) => {
                            const teamIdForAgent =
                              activeConversation.assigned_team_id &&
                              agent.team_id === activeConversation.assigned_team_id
                                ? activeConversation.assigned_team_id
                                : null;
                            return (
                              <Button
                                key={agent.id}
                                type="button"
                                size="sm"
                                variant={
                                  activeConversation.assigned_user_id === agent.id
                                    ? 'default'
                                    : 'outline'
                                }
                                aria-pressed={activeConversation.assigned_user_id === agent.id}
                                disabled={updatingConversation}
                                onClick={() =>
                                  void updateConversationAssignment(agent.id, teamIdForAgent)
                                }
                              >
                                Assign to{' '}
                                {agent.id === client.currentUser?.id ? 'you' : agent.login}
                              </Button>
                            );
                          })}
                        </div>
                        <div className="flex flex-wrap gap-2" aria-label="Assign to team">
                          {(agentsQuery.data?.teams ?? []).map((team) => {
                            const assignedAgent = agentsQuery.data?.members.find(
                              (agent) => agent.id === activeConversation.assigned_user_id
                            );
                            const userIdForTeam =
                              assignedAgent?.team_id === team.id ? assignedAgent.id : null;
                            return (
                              <Button
                                key={team.id}
                                type="button"
                                size="sm"
                                variant={
                                  activeConversation.assigned_team_id === team.id
                                    ? 'default'
                                    : 'outline'
                                }
                                aria-pressed={activeConversation.assigned_team_id === team.id}
                                disabled={updatingConversation}
                                onClick={() =>
                                  void updateConversationAssignment(userIdForTeam, team.id)
                                }
                              >
                                Assign to team {team.name}
                              </Button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </section>
                )}
                {activeConversation &&
                  canManageConversations &&
                  (labelsQuery.data ?? []).length > 0 && (
                    <div
                      className="flex w-full flex-wrap items-center gap-2"
                      aria-label="Conversation labels"
                    >
                      <span className="text-xs text-ink-faint">Labels</span>
                      {labelsQuery.data!.map((label) => {
                        const assigned =
                          activeConversation.labels?.some((item) => item.id === label.id) ?? false;
                        return (
                          <Button
                            key={label.id}
                            type="button"
                            size="sm"
                            variant={assigned ? 'default' : 'outline'}
                            aria-pressed={assigned}
                            disabled={
                              updatingConversation ||
                              (!assigned && (activeConversation.labels?.length ?? 0) >= 20)
                            }
                            style={{ borderColor: label.color }}
                            onClick={() => void toggleConversationLabel(label.id)}
                          >
                            {assigned ? `Remove ${label.name}` : `Add ${label.name}`}
                          </Button>
                        );
                      })}
                    </div>
                  )}
                {activeConversation &&
                  canSend &&
                  messagesQuery.data?.some((message) => message.direction === 'inbound') && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={markingRead}
                      onClick={() => void markConversationRead()}
                    >
                      {markingRead ? 'Marking read…' : 'Mark latest as read'}
                    </Button>
                  )}
              </div>
              {activeConversation?.is_group && (
                <span className="text-xs text-ink-faint">Group conversation</span>
              )}
            </div>
            {notesOpen && activeConversation && (
              <section
                id="whatsapp-internal-notes"
                aria-label="Internal notes"
                className="border-b-2 border-l-4 border-ink bg-paper p-3"
                style={{ borderLeftColor: 'var(--mw-yellow)' }}
              >
                <h3 className="font-display text-sm uppercase">Internal notes · team only</h3>
                {notesQuery.isLoading ? (
                  <div className="mt-2 space-y-2" aria-label="Loading internal notes">
                    <Skeleton className="h-12" />
                  </div>
                ) : notesQuery.isError ? (
                  <div className="mt-2 flex items-center gap-3" role="alert">
                    <p className="text-sm">Internal notes could not be loaded.</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={notesQuery.isFetching}
                      onClick={() => void notesQuery.refetch()}
                    >
                      Retry notes
                    </Button>
                  </div>
                ) : notesQuery.data?.length ? (
                  <ol className="mt-2 max-h-40 space-y-2 overflow-y-auto" aria-live="polite">
                    {notesQuery.data.map((note) => (
                      <li key={note.id} className="border border-ink/40 bg-paper p-2 text-sm">
                        <p className="whitespace-pre-wrap break-words">{note.body}</p>
                        <p className="mt-1 flex flex-wrap justify-between gap-2 font-mono text-[10px] text-ink-faint">
                          <span>{note.author_name || `User ${note.user_id}`}</span>
                          <time dateTime={note.create_date}>
                            {formatDateTime(note.create_date, 'dateTime')}
                          </time>
                        </p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-2 text-sm text-ink-faint">No internal notes yet.</p>
                )}
                {canManageConversations ? (
                  <form onSubmit={addInternalNote} className="mt-2 flex flex-col gap-2">
                    <Textarea
                      aria-label="Internal note"
                      placeholder="Write a note for your team…"
                      value={noteDraft}
                      onChange={(event) => setNoteDraft(event.target.value)}
                      maxLength={4000}
                      rows={2}
                      disabled={creatingNote}
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] text-ink-faint">
                        {noteDraft.length}/4000
                      </span>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={creatingNote || !noteDraft.trim() || noteDraft.length > 4000}
                      >
                        {creatingNote ? 'Saving note…' : 'Add internal note'}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <p className="mt-2 text-xs text-ink-faint">
                    You can view notes but cannot add one.
                  </p>
                )}
              </section>
            )}
            {hasOlderMessages && (
              <Button
                type="button"
                variant="link"
                className="mx-auto"
                disabled={loadingOlderMessages}
                onClick={() => void loadOlderMessages()}
              >
                {loadingOlderMessages ? 'Loading older messages…' : 'Load older messages'}
              </Button>
            )}
            {hasNewMessages && (
              <Button
                type="button"
                size="sm"
                className="mx-auto"
                onClick={() => {
                  isNearLatestRef.current = true;
                  setHasNewMessages(false);
                  messageContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              >
                New messages · Jump to latest
              </Button>
            )}
            <div
              ref={messageContainerRef}
              className="min-h-0 flex flex-1 flex-col-reverse gap-3 overflow-y-auto p-4"
              onScroll={(event) => {
                const nearLatest = event.currentTarget.scrollTop >= -48;
                isNearLatestRef.current = nearLatest;
                if (nearLatest) {
                  if (hasNewMessages) setHasNewMessages(false);
                } else {
                  void loadOlderMessages();
                }
              }}
            >
              {messagesQuery.isError && !messagesQuery.data && (
                <div className="space-y-3 border-2 border-ink bg-pink p-3" role="alert">
                  <p className="text-sm">Messages could not be loaded.</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={messagesQuery.isFetching}
                    onClick={() => void messagesQuery.refetch()}
                  >
                    Retry messages
                  </Button>
                </div>
              )}
              {messagesQuery.isError && messagesQuery.data && (
                <p role="status" className="border border-ink/40 p-2 text-xs text-ink-faint">
                  Showing cached messages. Refresh failed; retrying automatically.
                </p>
              )}
              {messageList.map((message, index) => (
                <div key={message.id} className="contents">
                  {activeConversation?.unread_count > 0 && index === newMessagesDividerIndex && (
                    <div
                      role="separator"
                      aria-label="New messages"
                      className="w-full border-y border-ink/40 py-1 text-center text-xs font-semibold text-ink-faint"
                    >
                      New messages
                    </div>
                  )}
                  <article
                    id={`whatsapp-message-${message.id}`}
                    tabIndex={-1}
                    className={`group relative max-w-[85%] border-2 border-ink p-3 ${message.direction === 'outbound' ? 'ml-auto bg-pink/30' : 'mr-auto bg-white'}`}
                  >
                    {activeConversation?.is_group && (
                      <p className="mb-1 font-mono text-[10px] text-ink-faint">
                        {message.direction === 'outbound'
                          ? 'You'
                          : message.sender_display_name?.trim() ||
                            message.sender_jid?.split('@')[0]?.split(':')[0] ||
                            'Group participant'}
                      </p>
                    )}
                    <p
                      className={`whitespace-pre-wrap break-words text-sm ${message.is_deleted || message.provider_type ? 'italic text-ink-faint' : ''}`}
                    >
                      {message.is_deleted
                        ? 'This message was deleted'
                        : message.provider_type
                          ? messageFallbackLabel(message.provider_type)
                          : message.content}
                    </p>
                    {message.is_edited && !message.is_deleted && (
                      <span className="ml-2 text-[10px] italic text-ink-faint">Edited</span>
                    )}
                    {message.is_forwarded && (
                      <p className="mb-1 font-mono text-[10px] italic text-ink-faint">Forwarded</p>
                    )}
                    {message.reply_to && (
                      <Button
                        type="button"
                        variant="link"
                        className="mb-2 block h-auto w-full border-l-2 border-magenta pl-2 text-left text-xs text-ink-faint hover:text-ink"
                        onClick={() => void jumpToQuotedMessage(message)}
                        aria-label="Jump to quoted message"
                      >
                        {message.reply_to.unavailable
                          ? 'Quoted message unavailable'
                          : message.reply_to.content ||
                            messageFallbackLabel(message.reply_to.provider_type) ||
                            `[${message.reply_to.message_type || 'media'}]`}
                      </Button>
                    )}
                    {!message.is_deleted &&
                    !message.provider_type &&
                    message.media_scan_status === 'infected' ? (
                      <p role="status" className="mt-2 text-xs text-warning">
                        Attachment blocked by malware scan. It was removed and cannot be downloaded.
                      </p>
                    ) : (
                      !message.is_deleted &&
                      !message.provider_type &&
                      message.message_type !== 'text' && <MediaPreview message={message} />
                    )}
                    {!message.provider_type &&
                      message.media_scan_status !== 'infected' &&
                      message.media_file_name && (
                        <p className="mt-1 text-xs">
                          {safeMediaDownloadName(message.media_file_name).name}
                        </p>
                      )}
                    {summarizeReactions(message.reactions).length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1" aria-label="Message reactions">
                        {summarizeReactions(message.reactions).map((reaction) => (
                          <span
                            key={reaction.emoji}
                            role="img"
                            aria-label={`${reaction.emoji} reaction, ${reaction.count}${reaction.includesMe ? ', includes yours' : ''}`}
                            className={`border border-ink/50 px-2 py-0.5 text-xs ${reaction.includesMe ? 'bg-pink/40' : 'bg-paper'}`}
                          >
                            {reaction.emoji} {reaction.count}
                          </span>
                        ))}
                      </div>
                    )}
                    {message.content && !message.is_deleted && !message.provider_type && (
                      <Button
                        type="button"
                        variant="link"
                        className="absolute right-2 top-2 z-10 h-auto p-1 text-xs underline md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                        aria-label="Copy message"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(message.content ?? '');
                            toast.success('Message copied');
                          } catch {
                            toast.error('Could not copy message text');
                          }
                        }}
                      >
                        Copy
                      </Button>
                    )}
                    {canSend &&
                      !message.is_deleted &&
                      !message.provider_type &&
                      !['queued', 'sending', 'unknown'].includes(message.status) && (
                        <Button
                          type="button"
                          variant="link"
                          className="mt-1 h-auto p-0 text-xs underline"
                          aria-label="Reply to message"
                          onClick={() => setReplyingTo(message)}
                        >
                          Reply
                        </Button>
                      )}
                    {canSend &&
                      !message.is_deleted &&
                      !message.provider_type &&
                      ['received', 'sent', 'delivered', 'read'].includes(message.status) && (
                        <Button
                          type="button"
                          variant="link"
                          className="mt-1 h-auto p-0 text-xs underline"
                          aria-label="React to message"
                          onClick={() => setReactingTo(message)}
                        >
                          React
                        </Button>
                      )}
                    {canSend &&
                      !message.is_deleted &&
                      !message.provider_type &&
                      ['received', 'sent', 'delivered', 'read'].includes(message.status) && (
                        <Button
                          type="button"
                          variant="link"
                          className="ml-3 mt-1 h-auto p-0 text-xs underline"
                          aria-label="Forward message"
                          onClick={() => {
                            setForwardConversationSearch('');
                            setDebouncedForwardConversationSearch('');
                            setForwardShowArchived(false);
                            setForwardingMessage(message);
                          }}
                        >
                          Forward
                        </Button>
                      )}
                    {canManageMessages &&
                      message.direction === 'outbound' &&
                      !message.is_deleted &&
                      !message.provider_type &&
                      ['sent', 'delivered', 'read'].includes(message.status) && (
                        <>
                          {message.message_type === 'text' &&
                            clockNow > 0 &&
                            clockNow - Date.parse(message.create_date) >= 0 &&
                            clockNow - Date.parse(message.create_date) <= 15 * 60_000 && (
                              <Button
                                type="button"
                                variant="link"
                                className="ml-3 mt-1 h-auto p-0 text-xs underline"
                                aria-label="Edit message"
                                onClick={() => {
                                  setEditText(message.content ?? '');
                                  setEditingMessage(message);
                                }}
                              >
                                Edit
                              </Button>
                            )}
                          <Button
                            type="button"
                            variant="link"
                            className="ml-3 mt-1 h-auto p-0 text-xs underline"
                            aria-label="Delete message for everyone"
                            onClick={() => setRevokingMessage(message)}
                          >
                            Delete
                          </Button>
                        </>
                      )}
                    <p className="mt-2 flex flex-wrap justify-end gap-x-2 text-right font-mono text-[10px] text-ink-faint">
                      <time
                        dateTime={message.create_date}
                        aria-label={`Message time: ${formatDateTime(message.create_date, 'dateTime')}`}
                      >
                        {formatDateTime(message.create_date, 'dateTime')}
                      </time>
                      <span>{messageStatusLabel[message.status] ?? 'Status unavailable'}</span>
                    </p>
                    {message.last_error && (
                      <p role="status" className="mt-1 text-xs text-red-700">
                        {message.last_error}
                      </p>
                    )}
                    {message.status === 'failed' && message.retryable && (
                      <Button
                        type="button"
                        variant="link"
                        className="mt-1 h-auto p-0 text-xs underline"
                        onClick={async () => {
                          try {
                            await client.request(`/whatsapp/messages/${message.id}/retry`, {
                              method: 'POST',
                            });
                            await queryClient.invalidateQueries({
                              queryKey: scopedQueryKey(['whatsapp']),
                            });
                          } catch (error) {
                            toast.error(
                              error instanceof Error ? error.message : 'Retry could not be queued'
                            );
                          }
                        }}
                      >
                        Retry send
                      </Button>
                    )}
                  </article>
                </div>
              ))}
              {activeConversation?.unread_count > 0 &&
                newMessagesDividerIndex === messageList.length && (
                  <div
                    role="separator"
                    aria-label="New messages"
                    className="w-full border-y border-ink/40 py-1 text-center text-xs font-semibold text-ink-faint"
                  >
                    New messages
                  </div>
                )}
            </div>
            {activeConversation && canSend ? (
              <MessageComposer
                key={activeConversation.id}
                conversationId={activeConversation.id}
                replyTo={replyingTo}
                onCancelReply={() => setReplyingTo(null)}
                sendOnEnter={inboxPreferences.sendOnEnter}
                onSendOnEnterChange={(sendOnEnter) =>
                  setInboxPreferences((current) => ({ ...current, sendOnEnter }))
                }
              />
            ) : activeConversation ? (
              <p className="border-t-2 border-ink p-3 text-sm text-ink-faint">
                You have view-only access to WhatsApp messages.
              </p>
            ) : null}
          </div>
        </section>
      )}
      {!connected && status !== 'qr' && (
        <section className="border-2 border-ink bg-white p-8 text-center">
          <SmartphoneIcon className="mx-auto size-10" />
          <h2 className="mt-3 font-display text-xl uppercase">Connect a WhatsApp account</h2>
          <p className="mt-1 text-sm text-ink-faint">
            One WhatsApp account is available for this company.
          </p>
        </section>
      )}
    </main>
  );
}

function MessageComposer({
  conversationId,
  replyTo,
  onCancelReply,
  sendOnEnter,
  onSendOnEnterChange,
}: {
  conversationId: number;
  replyTo: Message | null;
  onCancelReply: () => void;
  sendOnEnter: boolean;
  onSendOnEnterChange: (value: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState | null>(null);
  const sendLock = useRef(false);
  const idempotencyKey = useRef(crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadAbortController = useRef<AbortController | null>(null);
  const previousUploadProgress = useRef({ loadedBytes: 0, sampledAt: 0 });
  useEffect(() => {
    idempotencyKey.current = crypto.randomUUID();
  }, [replyTo?.id]);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (sendLock.current || (!draft.trim() && !file)) return;
    if (file && file.size > MAX_ATTACHMENT_BYTES) {
      toast.error('File must be 10 MiB or smaller');
      return;
    }
    sendLock.current = true;
    setSending(true);
    setUploadProgress(file ? { percent: 0, bytesPerSecond: 0 } : null);
    const abortController = file ? new AbortController() : null;
    uploadAbortController.current = abortController;
    previousUploadProgress.current = { loadedBytes: 0, sampledAt: performance.now() };
    try {
      const body: FormData | Record<string, unknown> = file
        ? new FormData()
        : {
            content: draft.trim(),
            ...(replyTo ? { reply_to_message_id: replyTo.id } : {}),
          };
      if (body instanceof FormData) {
        body.set('content', draft.trim());
        if (replyTo) body.set('reply_to_message_id', String(replyTo.id));
        body.set('media', file!, file!.name);
      }
      const requestOptions = {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey.current },
        body,
      } as const;
      if (body instanceof FormData && abortController) {
        await client.requestWithUploadProgress(
          `/whatsapp/conversations/${conversationId}/messages`,
          {
            ...requestOptions,
            body,
            signal: abortController.signal,
            onUploadProgress: (progress) => {
              const sampledAt = performance.now();
              const previous = previousUploadProgress.current;
              const durationMs = Math.max(1, sampledAt - previous.sampledAt);
              const bytesPerSecond =
                Math.max(0, progress.loadedBytes - previous.loadedBytes) * (1000 / durationMs);
              previousUploadProgress.current = {
                loadedBytes: progress.loadedBytes,
                sampledAt,
              };
              setUploadProgress({ percent: progress.percent, bytesPerSecond });
            },
          }
        );
      } else {
        await client.request(`/whatsapp/conversations/${conversationId}/messages`, requestOptions);
      }
      setDraft('');
      setFile(null);
      onCancelReply();
      idempotencyKey.current = crypto.randomUUID();
      if (fileInput.current) fileInput.current.value = '';
      await queryClient.invalidateQueries({ queryKey: scopedQueryKey(['whatsapp']) });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        toast.error('Upload stopped. Your draft is saved; retry uses the same message key.');
      } else {
        toast.error(error instanceof Error ? error.message : 'Message could not be queued');
      }
    } finally {
      uploadAbortController.current = null;
      sendLock.current = false;
      setSending(false);
      setUploadProgress(null);
    }
  };
  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const shouldSend = sendOnEnter
      ? event.key === 'Enter' && !event.shiftKey
      : event.key === 'Enter' && (event.ctrlKey || event.metaKey);
    if (!shouldSend) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  return (
    <form onSubmit={send} className="flex flex-col gap-2 border-t-2 border-ink p-3">
      {replyTo && (
        <div className="flex items-start justify-between gap-3 border-l-2 border-magenta bg-cream p-2 text-xs">
          <p className="min-w-0 truncate">
            Replying to: {replyTo.content || `[${replyTo.message_type}]`}
          </p>
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 underline"
            onClick={onCancelReply}
          >
            Cancel reply
          </Button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <label
          className="cursor-pointer rounded border-2 border-ink p-2 hover:bg-pink/20"
          title="Attach media"
        >
          <span className="sr-only">Attach media</span>
          <AttachmentIcon className="size-4" />
          <Input
            type="file"
            ref={fileInput}
            disabled={sending}
            aria-label="Attach media"
            className="sr-only"
            accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx"
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null;
              if (selected && selected.size > MAX_ATTACHMENT_BYTES) {
                toast.error('File must be 10 MiB or smaller');
                event.target.value = '';
                setFile(null);
                return;
              }
              setFile(selected);
              idempotencyKey.current = crypto.randomUUID();
            }}
          />
        </label>
        <Textarea
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            idempotencyKey.current = crypto.randomUUID();
          }}
          placeholder="Write a message…"
          aria-label="Write a message"
          maxLength={8000}
          disabled={sending}
          rows={2}
          onKeyDown={handleComposerKeyDown}
          className="min-h-10 resize-y"
        />
        <Button
          type="submit"
          disabled={sending || (!draft.trim() && !file)}
          aria-label={sending ? 'Sending message' : 'Send message'}
        >
          {sending ? 'Sending…' : <SendIcon className="size-4" />}
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-ink-faint">
          <Checkbox
            checked={sendOnEnter}
            onChange={(event) => onSendOnEnterChange(event.target.checked)}
            aria-label="Press Enter to send"
          />
          Press Enter to send
        </label>
        <p className="text-[10px] text-ink-faint">
          {sendOnEnter ? 'Shift+Enter for a new line' : 'Ctrl+Enter to send'} · Media files up to 10
          MiB
        </p>
      </div>
      {file && (
        <p className="text-xs">
          Attached: {file.name}{' '}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 underline"
            onClick={() => {
              setFile(null);
              idempotencyKey.current = crypto.randomUUID();
              if (fileInput.current) fileInput.current.value = '';
            }}
          >
            Remove
          </Button>
        </p>
      )}
      {file && sending && uploadProgress && (
        <div className="space-y-2" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <p role="status">
              {uploadProgress.percent === null
                ? `Uploading ${file.name} · ${formatTransferRate(uploadProgress.bytesPerSecond)}`
                : `Uploading ${file.name} · ${uploadProgress.percent}% · ${formatTransferRate(uploadProgress.bytesPerSecond)}`}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => uploadAbortController.current?.abort()}
            >
              Cancel upload
            </Button>
          </div>
          <div
            role="progressbar"
            aria-label={`Upload progress for ${file.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={uploadProgress.percent ?? undefined}
            className="h-2 overflow-hidden border border-ink bg-paper-raised"
          >
            <div
              className="h-full bg-pink transition-[width] duration-150"
              style={{ width: `${uploadProgress.percent ?? 0}%` }}
            />
          </div>
        </div>
      )}
    </form>
  );
}

function GroupProfileSummary({
  profile,
  loading,
  failed,
  onRefresh,
}: {
  profile?: GroupProfile;
  loading: boolean;
  failed: boolean;
  onRefresh: () => void;
}) {
  if (loading) return <p className="mt-1 text-xs text-ink-faint">Loading group details…</p>;
  if (failed)
    return (
      <div className="mt-1 flex items-center gap-2 text-xs text-ink-faint">
        <span>Group details could not be loaded.</span>
        <Button type="button" variant="link" className="h-auto p-0" onClick={onRefresh}>
          Retry
        </Button>
      </div>
    );
  if (!profile) return null;
  return (
    <div className="mt-2 max-w-xl text-xs text-ink-faint">
      <p>
        {profile.participant_count === null
          ? 'Group participants'
          : `${profile.participant_count} participants`}
        {profile.stale ? ' · saved details' : ''}
      </p>
      {profile.topic && <p className="mt-1 whitespace-pre-wrap break-words">{profile.topic}</p>}
      {profile.participants.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer">Show participants</summary>
          <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto pl-4">
            {profile.participants.map((participant) => (
              <li key={participant.jid} className="break-all">
                {participant.display_name || participant.phone_number || participant.jid}
                {participant.is_super_admin ? ' · owner' : participant.is_admin ? ' · admin' : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      {profile.stale && (
        <Button type="button" variant="link" className="mt-1 h-auto p-0" onClick={onRefresh}>
          Refresh group details
        </Button>
      )}
    </div>
  );
}

function ContactProfileSummary({
  conversationId,
  profile,
  loading,
  failed,
  refreshing,
  onRefresh,
}: {
  conversationId: number;
  profile?: ContactProfile;
  loading: boolean;
  failed: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const [avatar, setAvatar] = useState<{ conversationId: number; url: string } | null>(null);
  useEffect(() => {
    if (!profile?.avatar_available) return;
    let active = true;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    void client
      .requestBlobWithDownloadProgress(`/whatsapp/conversations/${conversationId}/contact/avatar`, {
        signal: controller.signal,
        onDownloadProgress: () => undefined,
      })
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setAvatar({ conversationId, url: objectUrl });
      })
      .catch(() => undefined);
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [conversationId, profile?.avatar_available, profile?.picture_id]);
  if (loading) return <p className="mt-1 text-xs text-ink-faint">Loading contact profile…</p>;
  if (failed)
    return (
      <div className="mt-1 flex items-center gap-2 text-xs text-ink-faint">
        <span>Contact profile could not be refreshed.</span>
        <Button type="button" variant="link" className="h-auto p-0" onClick={onRefresh}>
          Retry
        </Button>
      </div>
    );
  if (!profile) return null;
  return (
    <div className="mt-2 flex max-w-xl items-center gap-2 text-xs text-ink-faint">
      {avatar?.conversationId === conversationId ? (
        <img
          src={avatar.url}
          alt={`${profile.name} WhatsApp profile photo`}
          className="size-9 shrink-0 rounded-full border border-ink/30 object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full border border-ink/30 bg-paper font-semibold text-ink"
        >
          {profile.name.slice(0, 1).toLocaleUpperCase() || '?'}
        </span>
      )}
      <span className="min-w-0">
        {profile.verified_name && profile.verified_name !== profile.name && (
          <span className="block truncate text-ink">{profile.verified_name}</span>
        )}
        {profile.phone_number && <span className="block">+{profile.phone_number}</span>}
        {profile.status && <span className="block truncate">About: {profile.status}</span>}
      </span>
      <Button
        type="button"
        variant="link"
        className="ml-auto h-auto shrink-0 p-0"
        disabled={refreshing}
        onClick={onRefresh}
      >
        {refreshing ? 'Refreshing…' : 'Refresh contact'}
      </Button>
    </div>
  );
}

function MediaPreview({ message }: { message: Message }) {
  const [url, setUrl] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string | null>(null);
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const [thumbnailSizeBytes, setThumbnailSizeBytes] = useState<number | null>(null);
  const [mode, setMode] = useState<'thumbnail' | 'original'>(
    message.message_type === 'image' || message.message_type === 'video' ? 'thumbnail' : 'original'
  );
  const [downloadProgress, setDownloadProgress] = useState<UploadProgressState | null>({
    percent: 0,
    bytesPerSecond: 0,
  });
  const [failed, setFailed] = useState(false);
  const [failureMessage, setFailureMessage] = useState('Attachment could not be loaded.');
  const [attempt, setAttempt] = useState(0);
  const downloadAbortController = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setUrl(null);
    setMimeType(null);
    setSizeBytes(null);
    setThumbnailSizeBytes(null);
    setFailed(false);
    downloadAbortController.current = controller;
    const previousProgress = { loadedBytes: 0, sampledAt: performance.now() };
    const isThumbnail = mode === 'thumbnail';
    const path = `/whatsapp/media/${message.id}${isThumbnail ? '/thumbnail' : ''}`;
    let responseHeaders: Readonly<Record<string, string>> = {};
    void client
      .requestBlobWithDownloadProgress(path, {
        signal: controller.signal,
        onDownloadProgress: (progress) => {
          if (!active) return;
          const sampledAt = performance.now();
          const durationMs = Math.max(1, sampledAt - previousProgress.sampledAt);
          const bytesPerSecond =
            Math.max(0, progress.loadedBytes - previousProgress.loadedBytes) * (1000 / durationMs);
          previousProgress.loadedBytes = progress.loadedBytes;
          previousProgress.sampledAt = sampledAt;
          setDownloadProgress({ percent: progress.percent, bytesPerSecond });
        },
        onDownloadResponse: (headers) => {
          responseHeaders = headers;
        },
      })
      .then((blob) => {
        if (active) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
          setThumbnailSizeBytes(isThumbnail ? blob.size : null);
          setMimeType(
            isThumbnail
              ? responseHeaders['x-original-content-type'] ||
                  blob.type ||
                  'application/octet-stream'
              : blob.type || 'application/octet-stream'
          );
          const originalSize = Number(responseHeaders['x-original-content-length']);
          setSizeBytes(
            isThumbnail
              ? Number.isSafeInteger(originalSize) && originalSize >= 0
                ? originalSize
                : null
              : blob.size
          );
        }
      })
      .catch((error: unknown) => {
        if (
          active &&
          isThumbnail &&
          message.message_type === 'video' &&
          error instanceof ApiError &&
          error.status === 415
        ) {
          setMode('original');
          return;
        }
        if (active) {
          setFailureMessage(mediaLoadFailureMessage(error));
          setFailed(true);
        }
      })
      .finally(() => {
        if (downloadAbortController.current === controller) downloadAbortController.current = null;
        if (active) setDownloadProgress(null);
      });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [message.id, message.message_type, mode, attempt]);
  if (failed)
    return (
      <div role="status" className="mt-2 flex items-center gap-2 text-xs text-ink-faint">
        <span>{failureMessage}</span>
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 underline"
          onClick={() => {
            setFailed(false);
            setFailureMessage('Attachment could not be loaded.');
            setUrl(null);
            setMimeType(null);
            setSizeBytes(null);
            setThumbnailSizeBytes(null);
            setDownloadProgress({ percent: 0, bytesPerSecond: 0 });
            setMode(
              message.message_type === 'image' || message.message_type === 'video'
                ? 'thumbnail'
                : 'original'
            );
            setAttempt((value) => value + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  if (!url)
    return (
      <div className="mt-2 space-y-2" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <p role="status">
            {downloadProgress?.percent === null || !downloadProgress
              ? `Downloading attachment · ${formatTransferRate(downloadProgress?.bytesPerSecond ?? 0)}`
              : `Downloading attachment · ${downloadProgress.percent}% · ${formatTransferRate(downloadProgress.bytesPerSecond)}`}
          </p>
          {!failed && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => downloadAbortController.current?.abort()}
            >
              Cancel download
            </Button>
          )}
        </div>
        {!failed && downloadProgress && (
          <div
            role="progressbar"
            aria-label={`Download progress for ${safeMediaDownloadName(message.media_file_name).name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={downloadProgress.percent ?? undefined}
            className="h-2 overflow-hidden border border-ink bg-paper-raised"
          >
            <div
              className="h-full bg-pink transition-[width] duration-150"
              style={{ width: `${downloadProgress.percent ?? 0}%` }}
            />
          </div>
        )}
      </div>
    );
  const safeName = safeMediaDownloadName(message.media_file_name);
  const metadata = (
    <p className="mt-1 text-xs text-ink-faint">
      {mode === 'thumbnail'
        ? `Preview thumbnail${thumbnailSizeBytes !== null ? ` · ${formatMediaSize(thumbnailSizeBytes)}` : ''}`
        : mimeType || 'Unknown file type'}
      {sizeBytes !== null
        ? ` · ${mode === 'thumbnail' ? 'Original ' : ''}${formatMediaSize(sizeBytes)}`
        : ''}
    </p>
  );
  if (mode === 'thumbnail')
    return (
      <div>
        <img
          src={url}
          alt={`${safeName.name} preview`}
          className="mt-2 max-h-64 max-w-full object-contain"
        />
        {metadata}
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 underline"
          onClick={() => setMode('original')}
        >
          {message.message_type === 'video' ? 'Load video' : 'Load original image'}
        </Button>
      </div>
    );
  if (mimeType?.startsWith('image/'))
    return (
      <div>
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={safeName.name} className="mt-2 max-h-64 max-w-full object-contain" />
        </a>
        {metadata}
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 underline"
          onClick={() => setMode('thumbnail')}
        >
          Show thumbnail
        </Button>
      </div>
    );
  if (mimeType?.startsWith('video/'))
    return (
      <div>
        <video controls src={url} className="mt-2 max-h-64 max-w-full" />
        {metadata}
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 underline"
          onClick={() => setMode('thumbnail')}
        >
          Show poster
        </Button>
      </div>
    );
  if (mimeType?.startsWith('audio/'))
    return (
      <div>
        <audio controls src={url} className="mt-2 max-w-full" />
        {metadata}
      </div>
    );
  if (mimeType === 'application/pdf')
    return (
      <div className="mt-2 space-y-1">
        <iframe
          src={url}
          title={`Sandboxed PDF preview: ${safeName.name}`}
          sandbox=""
          className="h-72 w-full border border-ink"
        />
        <p className="text-xs text-ink-faint">
          PDF preview is sandboxed. Download the file to use your PDF reader.
        </p>
        {metadata}
        <a href={url} download={safeName.name} className="inline-block underline">
          Download PDF
        </a>
      </div>
    );
  return (
    <div className="mt-2 space-y-1">
      <p className="text-sm">{safeName.name}</p>
      {metadata}
      {safeName.blockedExtension && (
        <p role="status" className="text-xs text-warning">
          Potentially active file type ({safeName.blockedExtension}) is renamed for safer download.
        </p>
      )}
      <a href={url} download={safeName.name} className="inline-block underline">
        Download attachment
      </a>
    </div>
  );
}

function mediaLoadFailureMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError')
    return 'Download cancelled. Try again when ready.';
  const message = error instanceof Error ? error.message : '';
  if (message.includes('10 MiB'))
    return 'This media exceeds the 10 MiB limit and cannot be cached.';
  if (error instanceof ApiError && error.status === 404)
    return 'This attachment is no longer available.';
  if (message === 'Media storage is temporarily unavailable')
    return 'Attachment storage is temporarily unavailable. Try again.';
  if (error instanceof ApiError && (error.status === 502 || message.includes('WhatsApp gateway')))
    return 'WhatsApp could not retrieve this attachment. Try again.';
  if (error instanceof ApiError && error.status === 503)
    return 'WhatsApp services are temporarily busy. Try again.';
  return 'Attachment could not be loaded. Try again.';
}

function readWhatsAppInboxPreferences(key: string): WhatsAppInboxPreferences {
  try {
    if (typeof window === 'undefined') return { ...defaultInboxPreferences };
    const raw = window.localStorage.getItem(key);
    if (!raw) return { ...defaultInboxPreferences };
    const value = JSON.parse(raw) as Partial<WhatsAppInboxPreferences>;
    const validFilters: ConversationFilter[] = ['all', 'unread', 'private', 'groups'];
    const validQueueFilters: QueueFilter[] = ['all', 'mine', 'unassigned'];
    const validWorkStates: WorkStateFilter[] = ['all', 'open', 'closed'];
    return {
      selectedConversationId:
        typeof value.selectedConversationId === 'number' &&
        Number.isSafeInteger(value.selectedConversationId) &&
        value.selectedConversationId > 0
          ? value.selectedConversationId
          : null,
      selectedLabelId:
        typeof value.selectedLabelId === 'number' &&
        Number.isSafeInteger(value.selectedLabelId) &&
        value.selectedLabelId > 0
          ? value.selectedLabelId
          : null,
      conversationFilter: validFilters.includes(value.conversationFilter as ConversationFilter)
        ? (value.conversationFilter as ConversationFilter)
        : defaultInboxPreferences.conversationFilter,
      queueFilter: validQueueFilters.includes(value.queueFilter as QueueFilter)
        ? (value.queueFilter as QueueFilter)
        : defaultInboxPreferences.queueFilter,
      teamId:
        typeof value.teamId === 'number' && Number.isSafeInteger(value.teamId) && value.teamId > 0
          ? value.teamId
          : null,
      workStateFilter: validWorkStates.includes(value.workStateFilter as WorkStateFilter)
        ? (value.workStateFilter as WorkStateFilter)
        : defaultInboxPreferences.workStateFilter,
      showArchived: typeof value.showArchived === 'boolean' ? value.showArchived : false,
      sendOnEnter: typeof value.sendOnEnter === 'boolean' ? value.sendOnEnter : true,
    };
  } catch {
    return { ...defaultInboxPreferences };
  }
}
