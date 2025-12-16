const { v4: uuidv4 } = require('uuid');
const { logger } = require('@librechat/data-schemas');
const { Constants, ContentTypes } = require('librechat-data-provider');
const { getMessages, saveMessage, saveConvo, getConvo, saveToKnowledge } = require('~/models');
const { getTeamAgents } = require('~/models/Conversation');
const { orchestrateTeamResponse } = require('~/server/services/Teams');
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
      responseMessageId, // Required for resume linkage
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
    const responseText = orchestrationResult.isPaused
      ? orchestrationResult.message
      : orchestrationResult.formattedResponse;

    const responseMessage = {
      messageId: responseMessageId,
      conversationId,
      parentMessageId: userMessageId,
      isCreatedByUser: false,
      user: userId,
      text: responseText,
      sender: 'Team',
      model: 'team-collaboration',
      endpoint: 'teams',
      content: [
        {
          type: ContentTypes.TEXT,
          [ContentTypes.TEXT]: responseText,
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

    // Send final event
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
