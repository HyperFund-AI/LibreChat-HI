import { useEffect, useState } from 'react';
import { v4 } from 'uuid';
import { SSE } from 'sse.js';
import { useSetRecoilState } from 'recoil';
import { useQueryClient } from '@tanstack/react-query';
import {
  request,
  Constants,
  QueryKeys,
  /* @ts-ignore */
  createPayload,
  LocalStorageKeys,
  removeNullishValues,
} from 'librechat-data-provider';
import type { TMessage, TPayload, TSubmission, EventSubmission } from 'librechat-data-provider';
import type { EventHandlerParams } from './useEventHandlers';
import type { TResData } from '~/common';
import { useGenTitleMutation, useGetStartupConfig, useGetUserBalance } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import useEventHandlers from './useEventHandlers';
import store, { teamCollaborationAtom, TeamCollaborationState, TeamThinkingStep } from '~/store';

const clearDraft = (conversationId?: string | null) => {
  if (conversationId) {
    localStorage.removeItem(`${LocalStorageKeys.TEXT_DRAFT}${conversationId}`);
    localStorage.removeItem(`${LocalStorageKeys.FILES_DRAFT}${conversationId}`);
  } else {
    localStorage.removeItem(`${LocalStorageKeys.TEXT_DRAFT}${Constants.NEW_CONVO}`);
    localStorage.removeItem(`${LocalStorageKeys.FILES_DRAFT}${Constants.NEW_CONVO}`);
  }
};

type ChatHelpers = Pick<
  EventHandlerParams,
  | 'setMessages'
  | 'getMessages'
  | 'setConversation'
  | 'setIsSubmitting'
  | 'newConversation'
  | 'resetLatestMessage'
>;

export default function useSSE(
  submission: TSubmission | null,
  chatHelpers: ChatHelpers,
  isAddedRequest = false,
  runIndex = 0,
) {
  const genTitle = useGenTitleMutation();
  const queryClient = useQueryClient();
  const setActiveRunId = useSetRecoilState(store.activeRunFamily(runIndex));

  const { token, isAuthenticated } = useAuthContext();
  const [completed, setCompleted] = useState(new Set());
  const setAbortScroll = useSetRecoilState(store.abortScrollFamily(runIndex));
  const setShowStopButton = useSetRecoilState(store.showStopButtonByIndex(runIndex));
  const setTeamCollaboration = useSetRecoilState(teamCollaborationAtom);
  const setIsTeamApprovalLoading = useSetRecoilState(store.isTeamApprovalLoading);

  const {
    setMessages,
    getMessages,
    setConversation,
    setIsSubmitting,
    newConversation,
    resetLatestMessage,
  } = chatHelpers;

  const {
    clearStepMaps,
    stepHandler,
    syncHandler,
    finalHandler,
    errorHandler,
    messageHandler,
    contentHandler,
    createdHandler,
    attachmentHandler,
    abortConversation,
  } = useEventHandlers({
    genTitle,
    setMessages,
    getMessages,
    setCompleted,
    isAddedRequest,
    setConversation,
    setIsSubmitting,
    newConversation,
    setShowStopButton,
    resetLatestMessage,
  });

  const { data: startupConfig } = useGetStartupConfig();
  const balanceQuery = useGetUserBalance({
    enabled: !!isAuthenticated && startupConfig?.balance?.enabled,
  });

  useEffect(() => {
    if (submission == null || Object.keys(submission).length === 0) {
      return;
    }

    let { userMessage } = submission;

    const payloadData = createPayload(submission);
    let { payload } = payloadData;
    payload = removeNullishValues(payload) as TPayload;

    let textIndex = null;
    clearStepMaps();

    const sse = new SSE(payloadData.server, {
      payload: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });

    sse.addEventListener('attachment', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        attachmentHandler({ data, submission: submission as EventSubmission });
      } catch (error) {
        console.error(error);
      }
    });

    sse.addEventListener('message', (e: MessageEvent) => {
      const data = JSON.parse(e.data);

      if (data.final != null) {
        clearDraft(submission.conversation?.conversationId);
        const { plugins, teamCreated } = data;

        // If team was created by Dr. Sterling, invalidate conversation to refresh team data
        if (teamCreated && submission.conversation?.conversationId) {
          // Invalidate conversation queries to refresh team data
          queryClient.invalidateQueries([
            QueryKeys.conversation,
            submission.conversation.conversationId,
          ]);
          queryClient.invalidateQueries([
            QueryKeys.conversation,
            submission.conversation.conversationId,
            'team',
          ]);
          // Clear team approval loading state
          setIsTeamApprovalLoading(false);
        }

        // Mark team collaboration as complete and reset after delay
        setTeamCollaboration((prev: TeamCollaborationState) => ({
          ...prev,
          phase: 'complete',
          isActive: prev.steps.length > 0, // Keep active briefly to show completion
        }));
        setTimeout(() => {
          setTeamCollaboration({
            isActive: false,
            conversationId: null,
            steps: [],
            currentAgent: null,
            phase: 'idle',
            agentThinking: {},
            agentCollaboration: {},
          });
        }, 3000);

        try {
          finalHandler(data, { ...submission, plugins } as EventSubmission);
        } catch (error) {
          console.error('Error in finalHandler:', error);
          setIsSubmitting(false);
          setShowStopButton(false);
          // Clear team approval loading state on error
          setIsTeamApprovalLoading(false);
        }
        (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();
        return;
      } else if (data.created != null) {
        const runId = v4();
        setActiveRunId(runId);
        userMessage = {
          ...userMessage,
          ...data.message,
          overrideParentMessageId: userMessage.overrideParentMessageId,
        };

        createdHandler(data, { ...submission, userMessage } as EventSubmission);
      } else if (data.event != null) {
        // Handle team collaboration events
        if (
          data.event === 'on_thinking' ||
          data.event === 'on_agent_start' ||
          data.event === 'on_agent_complete'
        ) {
          const eventData = data.data || {};
          const conversationId = submission?.conversation?.conversationId || '';

          setTeamCollaboration((prev: TeamCollaborationState) => {
            const agentName = eventData.agent || eventData.agentName || 'Team';
            const thinkingText = eventData.thinking || '';
            const action =
              eventData.action || (data.event === 'on_agent_start' ? 'working' : 'completed');

            // Determine phase based on event
            let phase = prev.phase;
            if (data.event === 'on_thinking') {
              if (action === 'analyzing' || action === 'planned') {
                phase = 'planning';
              } else if (action === 'working' || action === 'completed' || action === 'thinking') {
                phase = 'specialist-work';
              } else if (action === 'synthesizing') {
                phase = 'synthesis';
              } else if (action === 'complete') {
                phase = 'complete';
              }
            }

            // Update agent thinking/collaboration maps when we receive content
            const updatedAgentThinking = { ...prev.agentThinking };
            const updatedAgentCollaboration = { ...prev.agentCollaboration };
            const collaborationText = eventData.collaboration || '';

            // Handle collaboration events (team conversation)
            if (collaborationText && action === 'collaboration') {
              updatedAgentCollaboration[agentName] = collaborationText;

              // For collaboration events, update agentCollaboration AND add to steps (visible to user)
              const newStep: TeamThinkingStep = {
                id: v4(),
                agent: agentName,
                role: eventData.role || eventData.agentRole || '',
                action: 'collaboration',
                message: eventData.message || collaborationText.substring(0, 150),
                collaboration: collaborationText,
                timestamp: Date.now(),
              };

              return {
                ...prev,
                isActive: true,
                conversationId,
                currentAgent: agentName,
                phase,
                steps: [...prev.steps, newStep],
                agentThinking: updatedAgentThinking,
                agentCollaboration: updatedAgentCollaboration,
              };
            }

            // Handle thinking events (internal reasoning - less prominent)
            if (thinkingText && action === 'thinking') {
              updatedAgentThinking[agentName] = thinkingText;

              // For thinking events, only update agentThinking, don't add to steps
              return {
                ...prev,
                isActive: true,
                conversationId,
                currentAgent: agentName,
                phase,
                agentThinking: updatedAgentThinking,
                agentCollaboration: updatedAgentCollaboration,
              };
            }

            // For non-thinking events (working, completed, etc.), add to steps
            const newStep: TeamThinkingStep = {
              id: v4(),
              agent: agentName,
              role: eventData.role || eventData.agentRole || '',
              action,
              message:
                eventData.message ||
                `${agentName} ${data.event === 'on_agent_start' ? 'started working' : 'finished'}`,
              timestamp: Date.now(),
            };

            return {
              isActive: true,
              conversationId,
              steps: [...prev.steps, newStep],
              currentAgent: agentName,
              phase,
              agentThinking: updatedAgentThinking,
              agentCollaboration: updatedAgentCollaboration,
            };
          });
        } else {
          stepHandler(data, { ...submission, userMessage } as EventSubmission);
        }
      } else if (data.sync != null) {
        const runId = v4();
        setActiveRunId(runId);

        // Reset team collaboration state for new response
        setTeamCollaboration({
          isActive: false,
          conversationId: null,
          steps: [],
          currentAgent: null,
          phase: 'idle',
          agentThinking: {},
          agentCollaboration: {},
        });

        /* synchronize messages to Assistants API as well as with real DB ID's */
        syncHandler(data, { ...submission, userMessage } as EventSubmission);
      } else if (data.type != null) {
        const { text, index } = data;
        if (text != null && index !== textIndex) {
          textIndex = index;
        }

        contentHandler({ data, submission: submission as EventSubmission });
      } else {
        const text = data.text ?? data.response;
        const { plugin, plugins } = data;

        const initialResponse = {
          ...(submission.initialResponse as TMessage),
          parentMessageId: data.parentMessageId,
          messageId: data.messageId,
        };

        if (data.message != null) {
          messageHandler(text, { ...submission, plugin, plugins, userMessage, initialResponse });
        }
      }
    });

    sse.addEventListener('open', () => {
      setAbortScroll(false);
    });

    sse.addEventListener('cancel', async () => {
      const streamKey = (submission as TSubmission | null)?.['initialResponse']?.messageId;
      if (completed.has(streamKey)) {
        setIsSubmitting(false);
        setCompleted((prev) => {
          prev.delete(streamKey);
          return new Set(prev);
        });
        return;
      }

      setCompleted((prev) => new Set(prev.add(streamKey)));
      const latestMessages = getMessages();
      const conversationId = latestMessages?.[latestMessages.length - 1]?.conversationId;
      try {
        await abortConversation(
          conversationId ??
            userMessage.conversationId ??
            submission.conversation?.conversationId ??
            '',
          submission as EventSubmission,
          latestMessages,
        );
      } catch (error) {
        console.error('Error during abort:', error);
        setIsSubmitting(false);
        setShowStopButton(false);
      }
    });

    sse.addEventListener('error', async (e: MessageEvent) => {
      /* @ts-ignore */
      if (e.responseCode === 401) {
        /* token expired, refresh and retry */
        try {
          const refreshResponse = await request.refreshToken();
          const token = refreshResponse?.token ?? '';
          if (!token) {
            throw new Error('Token refresh failed.');
          }
          sse.headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          };

          request.dispatchTokenUpdatedEvent(token);
          sse.stream();
          return;
        } catch (error) {
          /* token refresh failed, continue handling the original 401 */
          console.log(error);
        }
      }

      console.log('error in server stream.');
      (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();

      // Clear team approval loading state on error
      setIsTeamApprovalLoading(false);

      let data: TResData | undefined = undefined;
      try {
        data = JSON.parse(e.data) as TResData;
      } catch (error) {
        console.error(error);
        console.log(e);
        setIsSubmitting(false);
      }

      errorHandler({ data, submission: { ...submission, userMessage } as EventSubmission });
    });

    setIsSubmitting(true);
    sse.stream();

    return () => {
      const isCancelled = sse.readyState <= 1;
      sse.close();
      if (isCancelled) {
        const e = new Event('cancel');
        /* @ts-ignore */
        sse.dispatchEvent(e);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission]);
}
