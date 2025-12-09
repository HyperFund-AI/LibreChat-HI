import React, { useState, useEffect } from 'react';
import { Users, Loader2, CheckCircle2, X, Bot, Briefcase, FileText } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { QueryKeys, Constants, dataService } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';

interface TeamAgent {
  agentId: string;
  role: string;
  name: string;
  instructions?: string;
  provider?: string;
  model?: string;
  responsibilities?: string;
}

interface TeamIndicatorProps {
  conversation: TConversation | null;
}

// Role to color mapping for avatars
const getRoleColor = (role: string): string => {
  const colors: Record<string, string> = {
    'Investment': 'from-emerald-500 to-teal-600',
    'Financial': 'from-green-500 to-emerald-600',
    'Technology': 'from-blue-500 to-indigo-600',
    'Technical': 'from-blue-500 to-indigo-600',
    'Engineering': 'from-indigo-500 to-purple-600',
    'Business': 'from-orange-500 to-red-500',
    'Market': 'from-pink-500 to-rose-600',
    'Operations': 'from-amber-500 to-orange-600',
    'Project': 'from-violet-500 to-purple-600',
    'Legal': 'from-slate-500 to-gray-600',
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
  if (role.toLowerCase().includes('investment') || role.toLowerCase().includes('financial')) return '💰';
  if (role.toLowerCase().includes('technology') || role.toLowerCase().includes('technical') || role.toLowerCase().includes('engineering')) return '⚙️';
  if (role.toLowerCase().includes('business') || role.toLowerCase().includes('market')) return '📈';
  if (role.toLowerCase().includes('operations') || role.toLowerCase().includes('warehouse')) return '🏭';
  if (role.toLowerCase().includes('project')) return '📋';
  if (role.toLowerCase().includes('legal')) return '⚖️';
  return '👤';
};

export default function TeamIndicator({ conversation }: TeamIndicatorProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [previousTeamCount, setPreviousTeamCount] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState<TeamAgent | null>(null);
  
  const conversationId = conversation?.conversationId;
  const isNewConvo = !conversationId || conversationId === Constants.NEW_CONVO;

  // Poll for team agents
  const { data: convoData, isLoading } = useQuery<TConversation>(
    [QueryKeys.conversation, conversationId, 'team'],
    () => dataService.getConversationById(conversationId!),
    {
      enabled: !isNewConvo && !!conversationId,
      refetchInterval: (data) => {
        const teamAgents = (data as TConversation & { teamAgents?: TeamAgent[] })?.teamAgents;
        const hasTeam = teamAgents && teamAgents.length > 0;
        return hasTeam ? false : 3000;
      },
      refetchOnWindowFocus: false,
    },
  );

  const teamAgents = ((convoData as TConversation & { teamAgents?: TeamAgent[] })?.teamAgents || []) as TeamAgent[];
  const hasTeam = teamAgents.length > 0;

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

  if (isLoading && !hasTeam) {
    return (
      <div className="flex items-center gap-1.5 rounded-md bg-yellow-500/20 px-2 py-1 text-xs text-yellow-600 dark:text-yellow-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Building team...</span>
      </div>
    );
  }

  if (!hasTeam) return null;

  return (
    <>
      {/* Trigger Button */}
      <button
        onClick={() => setIsModalOpen(true)}
        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
          showSuccess
            ? 'animate-pulse bg-green-500/20 text-green-600 dark:text-green-400'
            : 'bg-blue-500/20 text-blue-600 hover:bg-blue-500/30 dark:text-blue-400'
        }`}
      >
        {showSuccess ? (
          <>
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>Team Ready!</span>
          </>
        ) : (
          <>
            <Users className="h-3.5 w-3.5" />
            <span>{teamAgents.length} Team Members</span>
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
            className="relative mx-4 max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="border-b border-gray-200 bg-gradient-to-r from-blue-600 to-purple-600 px-6 py-4 dark:border-gray-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20">
                    <Users className="h-5 w-5 text-white" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-white">Team Members</h2>
                    <p className="text-sm text-white/80">{teamAgents.length} specialists working on your document</p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setIsModalOpen(false);
                    setSelectedAgent(null);
                  }}
                  className="rounded-full p-2 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="max-h-[60vh] overflow-y-auto p-6">
              {selectedAgent ? (
                /* Agent Detail View */
                <div className="space-y-4">
                  <button
                    onClick={() => setSelectedAgent(null)}
                    className="mb-2 text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400"
                  >
                    ← Back to team
                  </button>
                  
                  <div className="flex items-start gap-4">
                    <div className={`flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${getRoleColor(selectedAgent.role)} text-2xl shadow-lg`}>
                      {getRoleIcon(selectedAgent.role)}
                    </div>
                    <div>
                      <h3 className="text-xl font-bold text-gray-900 dark:text-white">
                        {selectedAgent.name}
                      </h3>
                      <p className="text-sm text-gray-500 dark:text-gray-400">{selectedAgent.role}</p>
                    </div>
                  </div>

                  {selectedAgent.instructions && (
                    <div className="mt-4 rounded-xl bg-gray-50 p-4 dark:bg-gray-800">
                      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                        <FileText className="h-4 w-4" />
                        Instructions
                      </div>
                      <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                        {selectedAgent.instructions}
                      </p>
                    </div>
                  )}

                  {selectedAgent.responsibilities && (
                    <div className="rounded-xl bg-gray-50 p-4 dark:bg-gray-800">
                      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                        <Briefcase className="h-4 w-4" />
                        Responsibilities
                      </div>
                      <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                        {selectedAgent.responsibilities}
                      </p>
                    </div>
                  )}

                  <div className="flex gap-4 text-xs text-gray-500 dark:text-gray-400">
                    {selectedAgent.provider && (
                      <span className="flex items-center gap-1">
                        <Bot className="h-3 w-3" />
                        {selectedAgent.provider}
                      </span>
                    )}
                    {selectedAgent.model && (
                      <span className="rounded bg-gray-100 px-2 py-0.5 dark:bg-gray-800">
                        {selectedAgent.model}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                /* Team Grid View */
                <div className="grid gap-3 sm:grid-cols-2">
                  {teamAgents.map((agent, index) => (
                    <button
                      key={agent.agentId || index}
                      onClick={() => setSelectedAgent(agent)}
                      className="group flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 text-left transition-all hover:border-blue-300 hover:shadow-md dark:border-gray-700 dark:bg-gray-800 dark:hover:border-blue-600"
                    >
                      <div className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${getRoleColor(agent.role)} text-lg shadow-md transition-transform group-hover:scale-105`}>
                        {getRoleIcon(agent.role)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate font-semibold text-gray-900 dark:text-white">
                          {agent.name}
                        </h3>
                        <p className="truncate text-sm text-gray-500 dark:text-gray-400">
                          {agent.role}
                        </p>
                        <p className="mt-1 text-xs text-blue-600 opacity-0 transition-opacity group-hover:opacity-100 dark:text-blue-400">
                          Click for details →
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-gray-200 bg-gray-50 px-6 py-3 dark:border-gray-700 dark:bg-gray-800/50">
              <p className="text-center text-xs text-gray-500 dark:text-gray-400">
                🤖 Team automatically created based on your uploaded document
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
