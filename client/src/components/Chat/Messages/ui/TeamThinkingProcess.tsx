import React, { memo, useMemo, useState, useEffect, useRef } from 'react';
import { useRecoilValue } from 'recoil';
import { Brain, ChevronDown, ChevronUp, Loader2, MessageSquare, Users } from 'lucide-react';
import { teamCollaborationAtom } from '~/store/teamCollaboration';
import MarkdownLite from '~/components/Chat/Messages/Content/MarkdownLite';
import { cn } from '~/utils';
import { useLocalize } from '~/hooks';

type TeamThinkingProcessProps = {
  isSubmitting?: boolean;
};

// Animated entry component (reused for thinking and collaboration)
const AnimatedEntry = memo(
  ({
    agent,
    content,
    type = 'thinking',
  }: {
    agent: string;
    content: string;
    type?: 'thinking' | 'collaboration';
  }) => {
    const [isVisible, setIsVisible] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const prevLengthRef = useRef(0);
    const timeoutRef = useRef<NodeJS.Timeout>();

    const isCollaboration = type === 'collaboration';
    const accentColor = isCollaboration ? 'emerald' : 'amber';

    useEffect(() => {
      if (content && content.length > 0 && !isVisible) {
        setIsVisible(true);
      }

      const currentLength = content.length;
      const prevLength = prevLengthRef.current;

      if (currentLength > prevLength) {
        setIsStreaming(true);
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
          setIsStreaming(false);
        }, 500);
      }

      prevLengthRef.current = currentLength;
    }, [content, isVisible]);

    useEffect(() => {
      return () => {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
      };
    }, []);

    return (
      <div
        className={cn(
          'flex flex-col gap-2 transition-all duration-500 ease-out',
          isVisible ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0',
        )}
      >
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'h-2 w-2 animate-pulse rounded-full',
              isCollaboration ? 'bg-emerald-500' : 'bg-amber-500',
            )}
          />
          <span
            className={cn(
              'text-xs font-semibold transition-colors duration-200',
              isCollaboration
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-gray-600 dark:text-gray-400',
            )}
          >
            {agent}
          </span>
          {isCollaboration && <MessageSquare className="h-3 w-3 text-emerald-500" />}
        </div>
        <div
          className={cn(
            'prose prose-sm dark:prose-invert max-w-none transition-all duration-300 ease-in-out',
            'ml-4 border-l-2 pl-3',
            isCollaboration
              ? 'text-gray-800 dark:text-gray-200'
              : 'text-gray-600 dark:text-gray-400',
            isStreaming
              ? isCollaboration
                ? 'border-emerald-500/70'
                : 'border-amber-500/50'
              : isCollaboration
                ? 'border-emerald-500/40'
                : 'border-amber-500/30',
          )}
        >
          <div className="transition-opacity duration-200">
            <MarkdownLite content={content} codeExecution={false} />
          </div>
          {isStreaming && (
            <span
              className={cn(
                'ml-1 inline-block h-4 w-0.5 animate-pulse align-middle',
                isCollaboration ? 'bg-emerald-500/70' : 'bg-amber-500/70',
              )}
            />
          )}
        </div>
      </div>
    );
  },
);

AnimatedEntry.displayName = 'AnimatedEntry';

const TeamThinkingProcess = memo(({ isSubmitting }: TeamThinkingProcessProps) => {
  const localize = useLocalize();
  const collaboration = useRecoilValue(teamCollaborationAtom);
  const [isExpanded, setIsExpanded] = useState(true);
  const [showThinking, setShowThinking] = useState(false);

  // Get collaboration entries (team conversation - primary)
  const collaborationEntries = useMemo(() => {
    return Object.entries(collaboration.agentCollaboration || {})
      .filter(([, content]) => content && content.trim())
      .map(([agent, content]) => ({ agent, content }));
  }, [collaboration.agentCollaboration]);

  // Get thinking entries (internal reasoning - secondary)
  const thinkingEntries = useMemo(() => {
    return Object.entries(collaboration.agentThinking)
      .filter(([, thinking]) => thinking && thinking.trim())
      .map(([agent, thinking]) => ({ agent, thinking }));
  }, [collaboration.agentThinking]);

  // Get current phase info for display
  const phaseInfo = useMemo(() => {
    const { phase, currentAgent } = collaboration;
    return {
      phase,
      currentAgent: currentAgent || '',
      hasContent: collaborationEntries.length > 0 || thinkingEntries.length > 0,
    };
  }, [collaboration, collaborationEntries, thinkingEntries]);

  // Show if submitting
  if (!isSubmitting) {
    return null;
  }

  // Check if we have any collaboration activity
  const hasCollaborationData =
    collaboration.isActive || collaborationEntries.length > 0 || thinkingEntries.length > 0;

  return (
    <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 dark:bg-emerald-500/10">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left transition-colors hover:bg-emerald-500/10 dark:hover:bg-emerald-500/20"
      >
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-emerald-500" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Team Collaboration
          </span>
          <Loader2 className="h-3 w-3 animate-spin text-emerald-500" />
        </div>
        {isExpanded ? (
          <ChevronUp className="h-4 w-4 text-gray-500" />
        ) : (
          <ChevronDown className="h-4 w-4 text-gray-500" />
        )}
      </button>

      {isExpanded && (
        <div className="border-t border-emerald-500/20 px-4 py-3">
          {hasCollaborationData ? (
            <>
              {/* Current progress indicator */}
              {phaseInfo.currentAgent && (
                <div className="mb-3 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                  <span className="font-medium">{phaseInfo.currentAgent}</span>
                  <span className="text-gray-500">is contributing...</span>
                </div>
              )}

              {/* Team Conversation (Collaboration) - Primary */}
              {collaborationEntries.length > 0 && (
                <div className="flex flex-col gap-4">
                  {collaborationEntries.map((entry, idx) => (
                    <AnimatedEntry
                      key={`collab-${entry.agent}-${idx}`}
                      agent={entry.agent}
                      content={entry.content}
                      type="collaboration"
                    />
                  ))}
                </div>
              )}

              {/* Thinking section (collapsible) */}
              {thinkingEntries.length > 0 && (
                <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-700">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowThinking(!showThinking);
                    }}
                    className="mb-2 flex items-center gap-2 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
                  >
                    <Brain className="h-3 w-3" />
                    <span>Internal Reasoning ({thinkingEntries.length})</span>
                    {showThinking ? (
                      <ChevronUp className="h-3 w-3" />
                    ) : (
                      <ChevronDown className="h-3 w-3" />
                    )}
                  </button>
                  {showThinking && (
                    <div className="flex flex-col gap-3 opacity-70">
                      {thinkingEntries.map((entry, idx) => (
                        <AnimatedEntry
                          key={`think-${entry.agent}-${idx}`}
                          agent={entry.agent}
                          content={entry.thinking}
                          type="thinking"
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Fallback if no content yet */}
              {collaborationEntries.length === 0 && thinkingEntries.length === 0 && (
                <div className="text-sm italic text-gray-500 dark:text-gray-400">
                  Waiting for team contributions...
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Initializing team collaboration...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

TeamThinkingProcess.displayName = 'TeamThinkingProcess';

export default TeamThinkingProcess;
