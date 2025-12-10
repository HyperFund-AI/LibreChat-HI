import React, { memo, useEffect, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { Users, Brain, CheckCircle2, Loader2, Sparkles } from 'lucide-react';
import { teamCollaborationAtom } from '~/store/teamCollaboration';
import { cn } from '~/utils';

const TeamCollaboration = memo(() => {
  const collaboration = useRecoilValue(teamCollaborationAtom);
  const [isVisible, setIsVisible] = useState(false);

  // Get the latest step (current activity)
  const currentStep =
    collaboration.steps.length > 0 ? collaboration.steps[collaboration.steps.length - 1] : null;

  // Show/hide based on activity
  useEffect(() => {
    if (collaboration.isActive && collaboration.steps.length > 0) {
      setIsVisible(true);
    }
    if (collaboration.phase === 'complete') {
      const timer = setTimeout(() => setIsVisible(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [collaboration.isActive, collaboration.steps.length, collaboration.phase]);

  if (!isVisible || !currentStep) {
    return null;
  }

  // Determine icon and colors based on action
  const getStepDisplay = () => {
    switch (currentStep.action) {
      case 'analyzing':
        return {
          icon: <Brain className="h-4 w-4 animate-pulse" />,
          color: 'text-blue-500',
          borderColor: 'border-blue-500/40',
          bgColor: 'bg-blue-500/10',
        };
      case 'planned':
        return {
          icon: <CheckCircle2 className="h-4 w-4" />,
          color: 'text-green-500',
          borderColor: 'border-green-500/40',
          bgColor: 'bg-green-500/10',
        };
      case 'working':
        return {
          icon: <Loader2 className="h-4 w-4 animate-spin" />,
          color: 'text-amber-500',
          borderColor: 'border-amber-500/40',
          bgColor: 'bg-amber-500/10',
        };
      case 'completed':
        return {
          icon: <CheckCircle2 className="h-4 w-4" />,
          color: 'text-green-500',
          borderColor: 'border-green-500/40',
          bgColor: 'bg-green-500/10',
        };
      case 'synthesizing':
        return {
          icon: <Sparkles className="h-4 w-4 animate-pulse" />,
          color: 'text-purple-500',
          borderColor: 'border-purple-500/40',
          bgColor: 'bg-purple-500/10',
        };
      case 'complete':
        return {
          icon: <CheckCircle2 className="h-4 w-4" />,
          color: 'text-green-500',
          borderColor: 'border-green-500/40',
          bgColor: 'bg-green-500/10',
        };
      default:
        return {
          icon: <Loader2 className="h-4 w-4 animate-spin" />,
          color: 'text-gray-500',
          borderColor: 'border-gray-500/40',
          bgColor: 'bg-gray-500/10',
        };
    }
  };

  const display = getStepDisplay();
  const completedCount = collaboration.steps.filter(
    (s) => s.action === 'completed' || s.action === 'complete' || s.action === 'planned',
  ).length;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center px-4">
      <div
        className={cn(
          'pointer-events-auto flex items-center gap-3 rounded-full border px-4 py-2 shadow-lg backdrop-blur-md transition-all duration-300',
          display.borderColor,
          display.bgColor,
          'bg-white/95 dark:bg-gray-900/95',
        )}
      >
        {/* Team Avatar */}
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-purple-500 to-blue-500">
          <Users className="h-4 w-4 text-white" />
        </div>

        {/* Current Activity */}
        <div className="flex items-center gap-2">
          <span className={cn('flex-shrink-0', display.color)}>{display.icon}</span>
          <span className="font-medium text-gray-900 dark:text-white">{currentStep.agent}</span>
        </div>

        {/* Message */}
        <span className="max-w-xs truncate text-sm text-gray-600 dark:text-gray-300">
          {currentStep.message}
        </span>

        {/* Progress indicator */}
        {collaboration.phase !== 'complete' ? (
          <div className="flex items-center gap-1.5 rounded-full bg-gray-200/50 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700/50 dark:text-gray-300">
            <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            <span>{completedCount}</span>
          </div>
        ) : (
          <div className="flex items-center gap-1 rounded-full bg-green-500/20 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
            <CheckCircle2 className="h-3 w-3" />
          </div>
        )}
      </div>
    </div>
  );
});

TeamCollaboration.displayName = 'TeamCollaboration';

export default TeamCollaboration;
