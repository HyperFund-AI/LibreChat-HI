import React, { memo, useMemo, useState, useEffect, useRef } from 'react';
import { useRecoilValue } from 'recoil';
import { Brain, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { teamCollaborationAtom } from '~/store/teamCollaboration';
import MarkdownLite from '~/components/Chat/Messages/Content/MarkdownLite';
import { cn } from '~/utils';

type TeamThinkingProcessProps = {
  isSubmitting?: boolean;
};

// Animated thinking entry component
const AnimatedThinkingEntry = memo(({ agent, thinking }: { agent: string; thinking: string }) => {
  const [isVisible, setIsVisible] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const prevLengthRef = useRef(0);
  const timeoutRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    // Fade in when first thinking appears
    if (thinking && thinking.length > 0 && !isVisible) {
      setIsVisible(true);
    }

    // Track if content is still streaming (growing)
    const currentLength = thinking.length;
    const prevLength = prevLengthRef.current;
    
    if (currentLength > prevLength) {
      setIsStreaming(true);
      // Clear existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      // Hide streaming indicator after 500ms of no updates
      timeoutRef.current = setTimeout(() => {
        setIsStreaming(false);
      }, 500);
    }
    
    prevLengthRef.current = currentLength;
  }, [thinking, isVisible]);

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
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2',
      )}
    >
      <div className="flex items-center gap-2">
        <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
        <span className="text-xs font-semibold text-gray-600 dark:text-gray-400 transition-colors duration-200">
          {agent}
        </span>
      </div>
      <div
        className={cn(
          'prose prose-sm dark:prose-invert max-w-none transition-all duration-300 ease-in-out',
          'ml-4 border-l-2 pl-3 text-gray-700 dark:text-gray-300',
          isStreaming ? 'border-amber-500/50' : 'border-amber-500/30',
        )}
      >
        <div className="transition-opacity duration-200">
          <MarkdownLite content={thinking} codeExecution={false} />
        </div>
        {isStreaming && (
          <span className="inline-block w-0.5 h-4 ml-1 bg-amber-500/70 animate-pulse align-middle" />
        )}
      </div>
    </div>
  );
});

AnimatedThinkingEntry.displayName = 'AnimatedThinkingEntry';

const TeamThinkingProcess = memo(({ isSubmitting }: TeamThinkingProcessProps) => {
  const collaboration = useRecoilValue(teamCollaborationAtom);
  const [isExpanded, setIsExpanded] = useState(true);

  // Get thinking entries directly from agentThinking map
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
      hasThinking: thinkingEntries.length > 0,
    };
  }, [collaboration, thinkingEntries]);

  // Show if submitting - the component will show waiting state if no collaboration data yet
  if (!isSubmitting) {
    return null;
  }

  // Check if we have any collaboration activity
  const hasCollaborationData = collaboration.isActive || thinkingEntries.length > 0;

  return (
    <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 dark:bg-amber-500/10">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left transition-colors hover:bg-amber-500/10 dark:hover:bg-amber-500/20"
      >
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Team Thinking Process
          </span>
          <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
        </div>
        {isExpanded ? (
          <ChevronUp className="h-4 w-4 text-gray-500" />
        ) : (
          <ChevronDown className="h-4 w-4 text-gray-500" />
        )}
      </button>

      {isExpanded && (
        <div className="border-t border-amber-500/20 px-4 py-3">
          {hasCollaborationData ? (
            <>
              {/* Current progress indicator */}
              {phaseInfo.currentAgent && (
                <div className="mb-3 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
                  <span className="font-medium">{phaseInfo.currentAgent}</span>
                  <span className="text-gray-500">is thinking...</span>
                </div>
              )}

              {/* Thinking entries from specialists */}
              {thinkingEntries.length > 0 ? (
                <div className="flex flex-col gap-4">
                  {thinkingEntries.map((entry, idx) => (
                    <AnimatedThinkingEntry
                      key={`${entry.agent}-${idx}`}
                      agent={entry.agent}
                      thinking={entry.thinking}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-sm italic text-gray-500 dark:text-gray-400">
                  Waiting for specialist thinking...
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
