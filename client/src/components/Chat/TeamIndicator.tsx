import React, { useState, useEffect, useMemo } from 'react';
import {
  Users,
  Loader2,
  CheckCircle2,
  X,
  Bot,
  Briefcase,
  FileText,
  Sparkles,
  Wand2,
  BookOpen,
  Trash2,
  Eye,
  Calendar,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRecoilState } from 'recoil';
import { QueryKeys, Constants, dataService } from 'librechat-data-provider';
import type { TConversation, TMessage } from 'librechat-data-provider';
import store from '~/store';

interface KnowledgeDocument {
  documentId: string;
  title: string;
  content: string;
  createdAt: string;
  tags: string[];
}

interface TeamAgent {
  agentId: string;
  role: string;
  name: string;
  instructions?: string;
  provider?: string;
  model?: string;
  responsibilities?: string;
  tier?: string;
  behavioralLevel?: string;
}

interface TeamIndicatorProps {
  conversation: TConversation | null;
}

// Team specification detection patterns
const TEAM_SPEC_PATTERNS = [
  '# SUPERHUMAN TEAM:',
  '## SUPERHUMAN SPECIFICATIONS',
  'SUPERHUMAN TEAM:',
  '## TEAM COMPOSITION',
  '### Team Member',
];

// Patterns that indicate team spec is still being generated (early markers)
const TEAM_SPEC_EARLY_PATTERNS = [
  'SUPERHUMAN',
  'Team Composition',
  'elite specialists',
  'top 0.1%',
  'Tier 3',
  'Project Lead',
];

// Role to color mapping for avatars
const getRoleColor = (role: string): string => {
  const colors: Record<string, string> = {
    Investment: 'from-emerald-500 to-teal-600',
    Financial: 'from-green-500 to-emerald-600',
    Technology: 'from-blue-500 to-indigo-600',
    Technical: 'from-blue-500 to-indigo-600',
    Engineering: 'from-indigo-500 to-purple-600',
    Business: 'from-orange-500 to-red-500',
    Market: 'from-pink-500 to-rose-600',
    Operations: 'from-amber-500 to-orange-600',
    Project: 'from-violet-500 to-purple-600',
    Legal: 'from-slate-500 to-gray-600',
    Quality: 'from-cyan-500 to-blue-600',
    Lead: 'from-yellow-500 to-orange-500',
  };

  for (const [key, color] of Object.entries(colors)) {
    if (role.toLowerCase().includes(key.toLowerCase())) {
      return color;
    }
  }
  return 'from-blue-500 to-purple-600';
};

// Role to icon mapping
const getRoleIcon = (role: string): string => {
  if (role.toLowerCase().includes('investment') || role.toLowerCase().includes('financial'))
    return '💰';
  if (
    role.toLowerCase().includes('technology') ||
    role.toLowerCase().includes('technical') ||
    role.toLowerCase().includes('engineering')
  )
    return '⚙️';
  if (role.toLowerCase().includes('business') || role.toLowerCase().includes('market')) return '📈';
  if (role.toLowerCase().includes('operations') || role.toLowerCase().includes('warehouse'))
    return '🏭';
  if (role.toLowerCase().includes('project') || role.toLowerCase().includes('lead')) return '📋';
  if (role.toLowerCase().includes('legal')) return '⚖️';
  if (role.toLowerCase().includes('quality')) return '✅';
  return '👤';
};

// Tier badge color
const getTierBadge = (tier?: string) => {
  switch (tier) {
    case '3':
      return {
        label: 'Lead',
        color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
      };
    case '4':
      return {
        label: 'Specialist',
        color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
      };
    case '5':
      return {
        label: 'QA',
        color: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
      };
    default:
      return null;
  }
};

// Extract text content from a message
const extractMessageText = (message: TMessage): string => {
  if (typeof message.text === 'string' && message.text) {
    return message.text;
  }
  if (message.content && Array.isArray(message.content)) {
    return message.content
      .filter((part: unknown) => {
        const p = part as { type?: string; text?: unknown };
        return p && p.type === 'text' && p.text;
      })
      .map((part: unknown) => {
        const p = part as { text?: string | { value?: string } };
        if (typeof p.text === 'string') return p.text;
        if (p.text && typeof p.text === 'object' && 'value' in p.text) return p.text.value || '';
        return '';
      })
      .join('\n');
  }
  return '';
};

// Check if text contains a team specification
const containsTeamSpec = (text: string): boolean => {
  if (!text || text.length < 100) return false;
  return TEAM_SPEC_PATTERNS.some((pattern) => text.includes(pattern));
};

// Approval keywords that indicate user is approving the team
const APPROVAL_KEYWORDS = [
  'approved',
  'approve',
  'confirm',
  'confirmed',
  'looks good',
  "let's go",
  'create the team',
  'perfect',
  'yes',
  'ok',
  'okay',
  'go ahead',
  'proceed',
  'create team',
];

// Check if message text contains approval keywords
const isApprovalMessage = (text: string): boolean => {
  if (!text) return false;
  const lowerText = text.toLowerCase().trim();
  return APPROVAL_KEYWORDS.some((keyword) => lowerText.includes(keyword.toLowerCase()));
};

export default function TeamIndicator({ conversation }: TeamIndicatorProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [previousTeamCount, setPreviousTeamCount] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState<TeamAgent | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [activeTab, setActiveTab] = useState<'team' | 'knowledge'>('team');
  const [selectedDocument, setSelectedDocument] = useState<KnowledgeDocument | null>(null);
  const queryClient = useQueryClient();
  const [isTeamApprovalLoading, setIsTeamApprovalLoading] = useRecoilState(
    store.isTeamApprovalLoading,
  );

  const conversationId = conversation?.conversationId;
  const isNewConvo = !conversationId || conversationId === Constants.NEW_CONVO;

  // Get messages for the conversation
  const { data: messages } = useQuery<TMessage[]>(
    [QueryKeys.messages, conversationId],
    () => dataService.getMessagesByConvoId(conversationId!),
    {
      enabled: !isNewConvo && !!conversationId,
      refetchOnWindowFocus: false,
    },
  );

  // Poll for team agents
  const {
    data: convoData,
    isLoading,
    refetch: refetchConvo,
  } = useQuery<TConversation>(
    [QueryKeys.conversation, conversationId, 'team'],
    () => dataService.getConversationById(conversationId!),
    {
      enabled: !isNewConvo && !!conversationId,
      refetchInterval: (data) => {
        const teamAgents = (data as TConversation & { teamAgents?: TeamAgent[] })?.teamAgents;
        const hasTeam = teamAgents && teamAgents.length > 0;
        return hasTeam ? false : 5000;
      },
      refetchOnWindowFocus: false,
    },
  );

  const teamAgents = ((convoData as TConversation & { teamAgents?: TeamAgent[] })?.teamAgents ||
    []) as TeamAgent[];
  const hasTeam = teamAgents.length > 0;

  // Query for knowledge base documents
  const { data: knowledgeData, refetch: refetchKnowledge } = useQuery(
    ['teamKnowledge', conversationId],
    () => dataService.getTeamKnowledge(conversationId!),
    {
      enabled: !isNewConvo && !!conversationId && hasTeam,
      refetchOnWindowFocus: false,
    },
  );

  const knowledgeDocs = (knowledgeData?.documents || []) as KnowledgeDocument[];

  // Mutation to delete a knowledge document
  const deleteKnowledgeMutation = useMutation({
    mutationFn: async (documentId: string) => {
      return dataService.deleteKnowledgeDocument(conversationId!, documentId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['teamKnowledge', conversationId]);
      refetchKnowledge();
      setSelectedDocument(null);
    },
  });

  // Find messages that contain team specifications
  const teamSpecMessage = useMemo(() => {
    if (!messages || hasTeam) return null;

    // Look for assistant messages with team specs (check from newest to oldest)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg.isCreatedByUser) {
        const text = extractMessageText(msg);
        if (containsTeamSpec(text)) {
          return { message: msg, text, isComplete: !msg.unfinished };
        }
      }
    }
    return null;
  }, [messages, hasTeam]);

  // Check if Dr. Sterling is currently generating a team spec (early detection)
  const isGeneratingTeamSpec = useMemo(() => {
    if (!messages || hasTeam) return false;

    // Check the latest message
    const latestAssistantMsg = [...(messages || [])].reverse().find((m) => !m.isCreatedByUser);
    if (!latestAssistantMsg) return false;

    const text = extractMessageText(latestAssistantMsg);

    // If message is unfinished and contains early team spec patterns
    if (latestAssistantMsg.unfinished) {
      return TEAM_SPEC_EARLY_PATTERNS.some((pattern) =>
        text.toLowerCase().includes(pattern.toLowerCase()),
      );
    }

    return false;
  }, [messages, hasTeam]);

  // Check if team spec is complete and waiting for user confirmation
  const awaitingConfirmation = useMemo(() => {
    if (!teamSpecMessage?.isComplete || hasTeam) return false;
    return true;
  }, [teamSpecMessage, hasTeam]);

  // Detect approval messages and set loading state
  useEffect(() => {
    if (!messages || hasTeam || isTeamApprovalLoading) return;

    // Check the latest user message for approval keywords
    const latestUserMessage = [...messages].reverse().find((m) => m.isCreatedByUser);
    if (latestUserMessage) {
      const text = extractMessageText(latestUserMessage);
      // Only set loading if we're awaiting confirmation and user sent approval
      if (awaitingConfirmation && isApprovalMessage(text)) {
        setIsTeamApprovalLoading(true);
        setIsCreating(true);
      }
    }
  }, [messages, awaitingConfirmation, hasTeam, isTeamApprovalLoading, setIsTeamApprovalLoading]);

  // Clear loading state when team is created
  useEffect(() => {
    if (hasTeam && isTeamApprovalLoading) {
      setIsTeamApprovalLoading(false);
      setIsCreating(false);
    }
  }, [hasTeam, isTeamApprovalLoading, setIsTeamApprovalLoading]);

  // Show success animation when team is created
  useEffect(() => {
    if (hasTeam && previousTeamCount === 0 && teamAgents.length > 0) {
      setShowSuccess(true);
      const timer = setTimeout(() => setShowSuccess(false), 5000);
      return () => clearTimeout(timer);
    }
    setPreviousTeamCount(teamAgents.length);
  }, [teamAgents.length, previousTeamCount, hasTeam]);

  // Close modal on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsModalOpen(false);
        setSelectedAgent(null);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  if (isNewConvo) return null;

  // Show "Designing Team..." while Dr. Sterling is generating team spec
  if (isGeneratingTeamSpec && !hasTeam) {
    return (
      <div className="flex items-center gap-1.5 rounded-md bg-gradient-to-r from-purple-500/20 to-blue-500/20 px-2.5 py-1 text-xs font-medium text-purple-600 dark:text-purple-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Designing Team...</span>
      </div>
    );
  }

  // Show "Awaiting Confirmation" when team spec is complete but not yet confirmed
  if (awaitingConfirmation && !hasTeam) {
    return (
      <div className="flex items-center gap-1.5 rounded-md bg-gradient-to-r from-amber-500/20 to-orange-500/20 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
        <Sparkles className="h-3.5 w-3.5" />
        <span>Review Team</span>
      </div>
    );
  }

  // Show "Creating Team..." when team is being created (isCreating state)
  if (isCreating && !hasTeam) {
    return (
      <div className="flex items-center gap-1.5 rounded-md bg-gradient-to-r from-green-500/20 to-emerald-500/20 px-2.5 py-1 text-xs font-medium text-green-600 dark:text-green-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Creating Team...</span>
      </div>
    );
  }

  if (isLoading && !hasTeam) {
    return null; // Don't show loading state, let message detection handle it
  }

  if (!hasTeam) return null;

  return (
    <>
      {/* Trigger Button - Team is ACTIVE and will respond to messages */}
      <button
        onClick={() => setIsModalOpen(true)}
        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
          showSuccess
            ? 'animate-pulse bg-green-500/20 text-green-600 dark:text-green-400'
            : 'bg-gradient-to-r from-emerald-500/20 to-blue-500/20 text-emerald-600 hover:from-emerald-500/30 hover:to-blue-500/30 dark:text-emerald-400'
        }`}
        title="Team Mode Active - Your messages will be answered by the team"
      >
        {showSuccess ? (
          <>
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>Team Ready!</span>
          </>
        ) : (
          <>
            <Users className="h-3.5 w-3.5" />
            <span className="flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              {teamAgents.length} Active
            </span>
          </>
        )}
      </button>

      {/* Modal Backdrop */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => {
            setIsModalOpen(false);
            setSelectedAgent(null);
          }}
        >
          {/* Modal Content */}
          <div
            className="relative mx-4 max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="border-b border-gray-200 bg-gradient-to-r from-blue-600 via-purple-600 to-indigo-600 px-6 py-4 dark:border-gray-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/20 backdrop-blur">
                    <Sparkles className="h-6 w-6 text-white" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white">Superhuman Team</h2>
                    <p className="text-sm text-white/80">
                      {teamAgents.length} elite specialists • Top 0.1% experts
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setIsModalOpen(false);
                    setSelectedAgent(null);
                    setSelectedDocument(null);
                  }}
                  className="rounded-full p-2 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-200 dark:border-gray-700">
              <button
                onClick={() => {
                  setActiveTab('team');
                  setSelectedDocument(null);
                }}
                className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors ${
                  activeTab === 'team'
                    ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
                    : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                }`}
              >
                <Users className="h-4 w-4" />
                Team Members
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs dark:bg-blue-900/30">
                  {teamAgents.length}
                </span>
              </button>
              <button
                onClick={() => {
                  setActiveTab('knowledge');
                  setSelectedAgent(null);
                }}
                className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors ${
                  activeTab === 'knowledge'
                    ? 'border-b-2 border-purple-500 text-purple-600 dark:text-purple-400'
                    : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                }`}
              >
                <BookOpen className="h-4 w-4" />
                Knowledge Base
                {knowledgeDocs.length > 0 && (
                  <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs dark:bg-purple-900/30">
                    {knowledgeDocs.length}
                  </span>
                )}
              </button>
            </div>

            {/* Content */}
            <div className="max-h-[60vh] overflow-y-auto p-6">
              {activeTab === 'team' ? (
                /* TEAM TAB */
                selectedAgent ? (
                  /* Agent Detail View */
                  <div className="space-y-4">
                    <button
                      onClick={() => setSelectedAgent(null)}
                      className="mb-2 flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400"
                    >
                      ← Back to team
                    </button>

                    <div className="flex items-start gap-4">
                      <div
                        className={`flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${getRoleColor(selectedAgent.role)} text-3xl shadow-lg`}
                      >
                        {getRoleIcon(selectedAgent.role)}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="text-2xl font-bold text-gray-900 dark:text-white">
                            {selectedAgent.name}
                          </h3>
                          {selectedAgent.tier && getTierBadge(selectedAgent.tier) && (
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${getTierBadge(selectedAgent.tier)?.color}`}
                            >
                              {getTierBadge(selectedAgent.tier)?.label}
                            </span>
                          )}
                        </div>
                        <p className="text-lg text-gray-500 dark:text-gray-400">
                          {selectedAgent.role}
                        </p>
                        {selectedAgent.behavioralLevel &&
                          selectedAgent.behavioralLevel !== 'NONE' && (
                            <p className="mt-1 text-sm text-purple-600 dark:text-purple-400">
                              🧠 Behavioral Science: {selectedAgent.behavioralLevel}
                            </p>
                          )}
                      </div>
                    </div>

                    {selectedAgent.responsibilities && (
                      <div className="mt-6 rounded-xl bg-blue-50 p-4 dark:bg-blue-900/20">
                        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-blue-700 dark:text-blue-300">
                          <Briefcase className="h-4 w-4" />
                          Expertise & Responsibilities
                        </div>
                        <p className="text-sm leading-relaxed text-blue-800 dark:text-blue-200">
                          {selectedAgent.responsibilities}
                        </p>
                      </div>
                    )}

                    {selectedAgent.instructions && (
                      <div className="rounded-xl bg-gray-50 p-4 dark:bg-gray-800">
                        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                          <FileText className="h-4 w-4" />
                          System Instructions
                        </div>
                        <div className="max-h-64 overflow-y-auto">
                          <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                            {selectedAgent.instructions}
                          </p>
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap gap-3 pt-2 text-xs text-gray-500 dark:text-gray-400">
                      {selectedAgent.provider && (
                        <span className="flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 dark:bg-gray-800">
                          <Bot className="h-3 w-3" />
                          {selectedAgent.provider}
                        </span>
                      )}
                      {selectedAgent.model && (
                        <span className="rounded-full bg-gray-100 px-3 py-1 dark:bg-gray-800">
                          {selectedAgent.model}
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  /* Team Grid View */
                  <div className="grid gap-4 sm:grid-cols-2">
                    {teamAgents.map((agent, index) => (
                      <button
                        key={agent.agentId || index}
                        onClick={() => setSelectedAgent(agent)}
                        className="group flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 text-left transition-all hover:border-blue-300 hover:shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:hover:border-blue-600"
                      >
                        <div
                          className={`flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${getRoleColor(agent.role)} text-xl shadow-md transition-transform group-hover:scale-110`}
                        >
                          {getRoleIcon(agent.role)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h3 className="truncate font-semibold text-gray-900 dark:text-white">
                              {agent.name}
                            </h3>
                            {agent.tier && getTierBadge(agent.tier) && (
                              <span
                                className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${getTierBadge(agent.tier)?.color}`}
                              >
                                {getTierBadge(agent.tier)?.label}
                              </span>
                            )}
                          </div>
                          <p className="truncate text-sm text-gray-500 dark:text-gray-400">
                            {agent.role}
                          </p>
                          <p className="mt-2 text-xs text-blue-600 opacity-0 transition-opacity group-hover:opacity-100 dark:text-blue-400">
                            View full profile →
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                )
              ) : /* KNOWLEDGE BASE TAB */
              selectedDocument ? (
                /* Document Detail View */
                <div className="space-y-4">
                  <button
                    onClick={() => setSelectedDocument(null)}
                    className="mb-2 flex items-center gap-1 text-sm text-purple-600 hover:text-purple-700 dark:text-purple-400"
                  >
                    ← Back to knowledge base
                  </button>

                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 text-xl shadow-lg">
                        📄
                      </div>
                      <div>
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white">
                          {selectedDocument.title}
                        </h3>
                        <p className="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
                          <Calendar className="h-3 w-3" />
                          {new Date(selectedDocument.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        if (confirm('Are you sure you want to delete this document?')) {
                          deleteKnowledgeMutation.mutate(selectedDocument.documentId);
                        }
                      }}
                      disabled={deleteKnowledgeMutation.isLoading}
                      className="rounded-lg bg-red-100 p-2 text-red-600 transition-colors hover:bg-red-200 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40"
                      title="Delete document"
                    >
                      {deleteKnowledgeMutation.isLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </button>
                  </div>

                  {selectedDocument.tags && selectedDocument.tags.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {selectedDocument.tags.map((tag, i) => (
                        <span
                          key={i}
                          className="rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="rounded-xl bg-gray-50 p-4 dark:bg-gray-800">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                      <FileText className="h-4 w-4" />
                      Document Content
                    </div>
                    <div className="max-h-96 overflow-y-auto">
                      <pre className="whitespace-pre-wrap text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                        {selectedDocument.content}
                      </pre>
                    </div>
                  </div>
                </div>
              ) : knowledgeDocs.length === 0 ? (
                /* Empty State */
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-purple-100 dark:bg-purple-900/30">
                    <BookOpen className="h-8 w-8 text-purple-500" />
                  </div>
                  <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-white">
                    No Documents Yet
                  </h3>
                  <p className="max-w-sm text-sm text-gray-500 dark:text-gray-400">
                    When the team generates documents, you can save them to the knowledge base for
                    future reference. Click "Save to KB" on any team output.
                  </p>
                </div>
              ) : (
                /* Knowledge Documents List */
                <div className="space-y-3">
                  {knowledgeDocs.map((doc, index) => (
                    <button
                      key={doc.documentId || index}
                      onClick={() => setSelectedDocument(doc)}
                      className="group flex w-full items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 text-left transition-all hover:border-purple-300 hover:shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:hover:border-purple-600"
                    >
                      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-purple-500 to-indigo-600 text-lg shadow-md">
                        📄
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="truncate font-semibold text-gray-900 dark:text-white">
                            {doc.title}
                          </h3>
                          <span className="flex-shrink-0 text-xs text-gray-400">
                            {new Date(doc.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm text-gray-500 dark:text-gray-400">
                          {doc.content.substring(0, 150)}...
                        </p>
                        <p className="mt-2 flex items-center gap-1 text-xs text-purple-600 opacity-0 transition-opacity group-hover:opacity-100 dark:text-purple-400">
                          <Eye className="h-3 w-3" />
                          View document →
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-gray-200 bg-gradient-to-r from-gray-50 to-gray-100 px-6 py-4 dark:border-gray-700 dark:from-gray-800/50 dark:to-gray-800">
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  ✨ Superhuman Team • Top 0.1% experts collaborating on your project
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400">Powered by</span>
                  <span className="rounded bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                    Dr. Sterling Framework
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
