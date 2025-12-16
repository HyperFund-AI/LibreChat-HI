const { v4: uuidv4 } = require('uuid');
const { logger } = require('@librechat/data-schemas');
const { Constants, ContentTypes } = require('librechat-data-provider');
const { getMessages, saveMessage, saveConvo, getConvo, saveToKnowledge } = require('~/models');
const { getTeamAgents } = require('~/models/Conversation');
const {
  orchestrateTeamResponse,
  executeQAGate,
  resumeQAGate,
  getOrchestrationState,
} = require('~/server/services/Teams');
const {
  extractArtifactsWithMetadata,
  getArtifactDedupeKey,
} = require('~/server/utils/artifactUtils');

/**
 * Team Chat Controller - Handles conversations with team collaboration
 *
 * When a conversation has team agents, this controller orchestrates
 * the team response instead of using a single agent.
 */

/**
 * Sends a Server-Sent Event to the client
 * @param {Response} res - Express response object
 * @param {Object} data - Data to send
 */
const sendSSE = (res, data) => {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

/**
 * Main team chat handler
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 */
const teamChatController = async (req, res) => {
  const {
    text,
    conversationId: reqConversationId,
    parentMessageId = Constants.NO_PARENT,
  } = req.body;

  const userId = req.user.id;
  let conversationId = reqConversationId;
  const isNewConvo = !conversationId || conversationId === Constants.NEW_CONVO;

  try {
    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Generate IDs
    const userMessageId = uuidv4();
    const responseMessageId = uuidv4();

    if (isNewConvo) {
      conversationId = uuidv4();
    }

    // Get team agents for this conversation
    const teamAgents = await getTeamAgents(conversationId);
    if (!teamAgents || teamAgents.length === 0) {
      sendSSE(res, {
        error: true,
        message: 'No team agents found for this conversation',
      });
      res.end();
      return;
    }

    logger.info(`[teamChatController] Processing team chat with ${teamAgents.length} agents`);

    // Get conversation history
    const conversationHistory = await getMessages({ conversationId }, '-createdAt');

    // Get file context if available
    let fileContext = '';
    const conversation = await getConvo(userId, conversationId);
    if (conversation?.teamFileId) {
      // TODO: Load file context from the team file
      // For now, we'll pass empty context
    }

    // Check for pending QA Gate state (user responding to approve/reject)
    const pendingState = getOrchestrationState(conversationId);
    if (pendingState?.phase === 'qa_gate') {
      logger.info('[teamChatController] Found pending QA Gate state, resuming...');

      // Create user message for the QA response
      const userMessage = {
        messageId: userMessageId,
        conversationId,
        parentMessageId,
        isCreatedByUser: true,
        user: userId,
        text,
        sender: 'User',
      };

      await saveMessage(req, userMessage, { context: 'teamChatController - QA response message' });

      sendSSE(res, {
        created: true,
        message: userMessage,
        conversationId,
      });

      // Resume QA Gate with user's response
      const qaResult = await resumeQAGate({
        pendingState,
        userResponse: text,
        apiKey: req.config?.endpoints?.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY,
        conversationId,
        onThinking: (thinkingData) => {
          sendSSE(res, {
            type: ContentTypes.THINKING,
            ...thinkingData,
          });
        },
        onStream: (chunk) => {
          sendSSE(res, {
            type: ContentTypes.TEXT,
            text: chunk,
          });
        },
      });

      // Create QA response message
      const qaResponseMessage = {
        messageId: responseMessageId,
        conversationId,
        parentMessageId: userMessageId,
        isCreatedByUser: false,
        user: userId,
        text: qaResult.formattedResponse,
        sender: 'Team',
        model: 'team-collaboration',
        endpoint: 'teams',
        content: [
          {
            type: ContentTypes.TEXT,
            [ContentTypes.TEXT]: qaResult.formattedResponse,
          },
        ],
        metadata: {
          qaApproved: qaResult.qaApproved,
          phase: 'qa_gate_complete',
        },
      };

      await saveMessage(req, qaResponseMessage, { context: 'teamChatController - QA response' });

      // Update conversation
      const convoUpdate = {
        conversationId,
        user: userId,
        endpoint: 'teams',
        model: 'team-collaboration',
        title: conversation?.title || 'Team Conversation',
      };

      await saveConvo(req, convoUpdate, { context: 'teamChatController - save convo after QA' });

      sendSSE(res, {
        final: true,
        conversation: convoUpdate,
        title: convoUpdate.title,
        requestMessage: userMessage,
        responseMessage: qaResponseMessage,
      });

      res.end();
      logger.info('[teamChatController] QA Gate resumption completed');
      return;
    }

    // Create user message
    const userMessage = {
      messageId: userMessageId,
      conversationId,
      parentMessageId,
      isCreatedByUser: true,
      user: userId,
      text,
      sender: 'User',
    };

    // Save user message
    await saveMessage(req, userMessage, { context: 'teamChatController - user message' });

    // Send created event
    sendSSE(res, {
      created: true,
      message: userMessage,
      conversationId,
    });

    // Track which agents are responding
    const respondingAgents = [];

    // Orchestrate team response
    const orchestrationResult = await orchestrateTeamResponse({
      userMessage: text,
      teamAgents,
      conversationHistory: conversationHistory || [],
      fileContext,
      config: req.config,
      conversationId, // For state persistence when waiting for user input
      onAgentStart: (agent) => {
        respondingAgents.push(agent);
        sendSSE(res, {
          type: ContentTypes.AGENT_START,
          agentId: agent.agentId,
          agentName: agent.name,
          agentRole: agent.role,
        });
      },
      onAgentComplete: (agentResponse) => {
        sendSSE(res, {
          type: ContentTypes.AGENT_RESPONSE,
          agentId: agentResponse.agentId,
          agentName: agentResponse.agentName,
          agentRole: agentResponse.agentRole,
          text: agentResponse.response,
        });
      },
    });

    if (!orchestrationResult.success) {
      sendSSE(res, {
        error: true,
        message: orchestrationResult.error || 'Team orchestration failed',
      });
      res.end();
      return;
    }

    // Create response message with team responses
    const responseMessage = {
      messageId: responseMessageId,
      conversationId,
      parentMessageId: userMessageId,
      isCreatedByUser: false,
      user: userId,
      text: orchestrationResult.formattedResponse,
      sender: 'Team',
      model: 'team-collaboration',
      endpoint: 'teams',
      content: [
        {
          type: ContentTypes.TEXT,
          [ContentTypes.TEXT]: orchestrationResult.formattedResponse,
        },
      ],
      // Store individual agent responses in metadata
      metadata: {
        teamResponses: orchestrationResult.responses.map((r) => ({
          agentId: r.agentId,
          agentName: r.agentName,
          agentRole: r.agentRole,
          response: r.response,
        })),
        selectedAgents: orchestrationResult.selectedAgents,
      },
    };

    // Save response message
    await saveMessage(req, responseMessage, { context: 'teamChatController - team response' });

    // Extract and save any artifacts to the knowledge base
    try {
      const artifacts = extractArtifactsWithMetadata(orchestrationResult.formattedResponse);

      if (artifacts.length > 0) {
        logger.info(
          `[teamChatController] Found ${artifacts.length} artifacts to save to Knowledge`,
        );

        for (const artifact of artifacts) {
          try {
            const dedupeKey = getArtifactDedupeKey({
              conversationId,
              title: artifact.title,
              identifier: artifact.identifier,
            });

            await saveToKnowledge({
              conversationId,
              dedupeKey,
              title: artifact.title || 'Untitled Artifact',
              content: artifact.content,
              messageId: responseMessageId,
              createdBy: responseMessage.sender, // 'Team' or specific agent name if obtainable
              tags: artifact.type ? [artifact.type] : [],
              metadata: {
                savedAt: new Date().toISOString(),
                identifier: artifact.identifier,
                type: artifact.type,
              },
              onlyUpdate: true,
            });
          } catch (artifactErr) {
            logger.error('[teamChatController] Error saving artifact to KB:', artifactErr);
            // Continue with other artifacts
          }
        }
      }
    } catch (kbError) {
      logger.error('[teamChatController] Error processing artifacts for KB:', kbError);
      // Non-blocking error
    }

    // Update conversation
    const convoUpdate = {
      conversationId,
      user: userId,
      endpoint: 'teams',
      model: 'team-collaboration',
      title: conversation?.title || 'Team Conversation',
    };

    await saveConvo(req, convoUpdate, { context: 'teamChatController - save convo' });

    // AUTO-TRIGGER QA GATE after deliverable is complete (Phase 5: Enhanced QA Gate Protocol)
    // Only trigger if orchestration completed with a deliverable (not waiting for specialist input)
    if (orchestrationResult.success && !orchestrationResult.waitingForInput) {
      // Check if QA agents exist (Tier 5)
      const qaAgents = teamAgents.filter((a) => parseInt(a.tier) === 5);

      if (qaAgents.length > 0) {
        logger.info(
          `[teamChatController] Found ${qaAgents.length} QA agent(s), triggering QA Gate`,
        );

        // Send deliverable first as an intermediate message
        sendSSE(res, {
          type: ContentTypes.TEXT,
          text: '\n\n---\n\n**Initiating QA Review...**\n\n',
        });

        // Execute QA Gate
        const qaResult = await executeQAGate({
          deliverable: orchestrationResult.formattedResponse,
          userMessage: text,
          teamAgents,
          specialistInputs: orchestrationResult.responses || [],
          apiKey: req.config?.endpoints?.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY,
          conversationId,
          onThinking: (thinkingData) => {
            sendSSE(res, {
              type: ContentTypes.THINKING,
              ...thinkingData,
            });
          },
          onStream: (chunk) => {
            sendSSE(res, {
              type: ContentTypes.TEXT,
              text: chunk,
            });
          },
        });

        if (qaResult.waitingForInput) {
          // QA Gate is waiting for user approval - send intermediate final event
          logger.info('[teamChatController] QA Gate waiting for user approval');

          // Create QA question message
          const qaQuestionMessage = {
            messageId: uuidv4(),
            conversationId,
            parentMessageId: responseMessageId,
            isCreatedByUser: false,
            user: userId,
            text: qaResult.formattedQuestion,
            sender: 'Team',
            model: 'team-collaboration',
            endpoint: 'teams',
            content: [
              {
                type: ContentTypes.TEXT,
                [ContentTypes.TEXT]: qaResult.formattedQuestion,
              },
            ],
            metadata: {
              qaAgentName: qaResult.qaAgentName,
              qaAgentRole: qaResult.qaAgentRole,
              phase: 'qa_gate_pending',
              waitingForInput: true,
            },
          };

          await saveMessage(req, qaQuestionMessage, {
            context: 'teamChatController - QA question',
          });

          sendSSE(res, {
            final: true,
            conversation: convoUpdate,
            title: convoUpdate.title,
            requestMessage: userMessage,
            responseMessage: qaQuestionMessage,
            qaWaitingForApproval: true,
          });

          res.end();
          logger.info('[teamChatController] QA Gate question sent, waiting for user response');
          return;
        }

        // QA Gate skipped (no QA agent) - this shouldn't happen since we checked above
        logger.info('[teamChatController] QA Gate completed without waiting');
      }
    }

    // Send final event (normal flow without QA Gate, or QA Gate skipped)
    sendSSE(res, {
      final: true,
      conversation: convoUpdate,
      title: convoUpdate.title,
      requestMessage: userMessage,
      responseMessage,
    });

    res.end();

    logger.info(`[teamChatController] Team chat completed successfully`);
  } catch (error) {
    logger.error('[teamChatController] Error:', error);

    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
    }

    sendSSE(res, {
      error: true,
      message: error.message || 'An error occurred during team collaboration',
    });

    res.end();
  }
};

/**
 * Check if a conversation should use team chat
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<boolean>}
 */
const shouldUseTeamChat = async (conversationId) => {
  if (!conversationId || conversationId === Constants.NEW_CONVO) {
    return false;
  }

  const teamAgents = await getTeamAgents(conversationId);
  return teamAgents && teamAgents.length > 0;
};

module.exports = {
  teamChatController,
  shouldUseTeamChat,
};
