const { sendEvent } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { Constants, ContentTypes } = require('librechat-data-provider');
const {
  handleAbortError,
  createAbortController,
  cleanupAbortController,
} = require('~/server/middleware');
const { disposeClient, clientRegistry, requestDataMap } = require('~/server/cleanup');
const { saveMessage } = require('~/models');
const { DR_STERLING_AGENT_ID, orchestrateTeamResponse } = require('~/server/services/Teams');
const { getTeamAgents, getTeamInfo } = require('~/models/Conversation');

function createCloseHandler(abortController) {
  return function (manual) {
    if (!manual) {
      logger.debug('[AgentController] Request closed');
    }
    if (!abortController) {
      return;
    } else if (abortController.signal.aborted) {
      return;
    } else if (abortController.requestCompleted) {
      return;
    }

    abortController.abort();
    logger.debug('[AgentController] Request aborted on close');
  };
}

/**
 * Handles team orchestration when a conversation has team agents
 * Shows collaboration progress ("thinking") and streams final response
 * @param {Object} params - Parameters
 * @param {string} params.text - The user's message or objective to work on
 * @param {string} params.conversationId - The conversation ID
 * @param {string} params.parentMessageId - Parent message ID
 * @param {Array} params.teamAgents - Array of team agents
 * @param {string} params.userId - User ID
 * @param {string} params.teamObjective - The stored team objective (optional)
 */
async function handleTeamOrchestration(req, res, { text, conversationId, parentMessageId, teamAgents, userId, teamObjective }) {
  const { v4: uuidv4 } = require('uuid');
  const { getMessages, saveConvo, getConvo } = require('~/models');
  
  try {
    logger.info(`[handleTeamOrchestration] Starting with ${teamAgents.length} team agents${teamObjective ? ', objective provided' : ''}`);
    
    const userMessageId = uuidv4();
    const responseMessageId = uuidv4();
    
    const conversationHistory = await getMessages({ conversationId }, '-createdAt') || [];
    const conversation = await getConvo(userId, conversationId);
    
    // Create and save user message
    const userMessage = {
      messageId: userMessageId,
      conversationId: conversationId,
      parentMessageId: parentMessageId || Constants.NO_PARENT,
      isCreatedByUser: true,
      user: userId,
      text: text,
      sender: 'User',
      endpoint: 'agents',
    };
    await saveMessage(req, userMessage, { context: 'handleTeamOrchestration - user message' });

    // Send sync event to establish the conversation
    sendEvent(res, {
      sync: true,
      conversationId,
      thread_id: conversationId,
      responseMessage: {
        messageId: responseMessageId,
        conversationId: conversationId,
        parentMessageId: userMessageId,
        isCreatedByUser: false,
        text: '',
        sender: 'Team',
      },
      requestMessage: userMessage,
    });

    // Track streamed content
    let streamedText = '';

    // Orchestrate team response with callbacks
    const orchestrationResult = await orchestrateTeamResponse({
      userMessage: text,
      teamAgents,
      conversationHistory,
      fileContext: '',
      config: req.config,
      
      // Show "thinking" process - team collaboration
      onThinking: (thinking) => {
        // Send as a "step" event to show progress
        sendEvent(res, {
          event: 'on_thinking',
          data: {
            agent: thinking.agent,
            role: thinking.role || '',
            action: thinking.action,
            message: thinking.message,
          },
        });
      },
      
      onAgentStart: (agent) => {
        // Show which agent is starting
        sendEvent(res, {
          event: 'on_agent_start',
          data: {
            agentId: agent.agentId,
            agentName: agent.name,
            agentRole: agent.role,
            phase: agent.phase || 'working',
          },
        });
      },
      
      onAgentComplete: (agentResponse) => {
        // Show agent completed
        sendEvent(res, {
          event: 'on_agent_complete',
          data: {
            agentName: agentResponse.agentName,
            agentRole: agentResponse.agentRole,
          },
        });
      },
      
      // Stream the final synthesized response - send accumulated text
      onStream: (chunk) => {
        streamedText += chunk;
        // Send the FULL accumulated text, not just the chunk
        // This is how the frontend content handler expects it
        sendEvent(res, {
          type: ContentTypes.TEXT,
          text: streamedText,
          index: 0,
          messageId: responseMessageId,
          conversationId: conversationId,
        });
      },
    });

    // Final response text
    const finalText = orchestrationResult.success 
      ? orchestrationResult.formattedResponse 
      : `Error: ${orchestrationResult.error || 'Team orchestration failed'}`;

    // Create and save response message
    const responseMessage = {
      messageId: responseMessageId,
      conversationId: conversationId,
      parentMessageId: userMessageId,
      isCreatedByUser: false,
      user: userId,
      text: finalText,
      sender: 'Team',
      model: 'team-collaboration',
      endpoint: 'agents',
      unfinished: false,
      error: !orchestrationResult.success,
    };
    await saveMessage(req, responseMessage, { context: 'handleTeamOrchestration - team response' });

    // Update conversation
    const convoUpdate = {
      conversationId: conversationId,
      user: userId,
      endpoint: 'agents',
      model: 'team-collaboration',
      title: conversation?.title || 'Team Conversation',
    };
    await saveConvo(req, convoUpdate, { context: 'handleTeamOrchestration - save convo' });

    // Send final event
    sendEvent(res, {
      final: true,
      conversation: convoUpdate,
      title: convoUpdate.title,
      requestMessage: userMessage,
      responseMessage: responseMessage,
    });

    res.end();
    logger.info(`[handleTeamOrchestration] Completed successfully`);
  } catch (error) {
    logger.error('[handleTeamOrchestration] Error:', error);
    
    sendEvent(res, {
      final: true,
      conversation: { conversationId },
      requestMessage: {
        messageId: uuidv4(),
        conversationId,
        parentMessageId: parentMessageId || Constants.NO_PARENT,
        isCreatedByUser: true,
        text,
      },
      responseMessage: {
        messageId: uuidv4(),
        conversationId: conversationId,
        parentMessageId: parentMessageId || Constants.NO_PARENT,
        isCreatedByUser: false,
        text: `Team collaboration error: ${error.message}`,
        sender: 'Team',
        error: true,
      },
    });
    res.end();
  }
}

const AgentController = async (req, res, next, initializeClient, addTitle) => {
  let {
    text,
    isRegenerate,
    endpointOption,
    conversationId,
    isContinued = false,
    editedContent = null,
    parentMessageId = null,
    overrideParentMessageId = null,
    responseMessageId: editedResponseMessageId = null,
  } = req.body;

  let sender;
  let abortKey;
  let userMessage;
  let promptTokens;
  let userMessageId;
  let responseMessageId;
  let userMessagePromise;
  let getAbortData;
  let client = null;
  let cleanupHandlers = [];

  const newConvo = !conversationId;
  const userId = req.user.id;

  // Check if Dr. Sterling was activated by middleware
  const drSterlingActivated = req.drSterlingContext?.activated || false;
  const userName = req.drSterlingContext?.userName || null;
  
  if (drSterlingActivated) {
    logger.info(`[AgentController] 🎩 Dr. Sterling mode active for user: ${userName}`);
  }

  // Check if this conversation has team agents and should use team orchestration
  // Skip team mode if Dr. Sterling was explicitly activated
  if (!drSterlingActivated && conversationId && conversationId !== Constants.NEW_CONVO) {
    try {
      const teamInfo = await getTeamInfo(conversationId);
      if (teamInfo && teamInfo.teamAgents && teamInfo.teamAgents.length > 0) {
        const { teamAgents, teamObjective } = teamInfo;
        logger.info(`[AgentController] 🤝 Team mode detected with ${teamAgents.length} agents${teamObjective ? ', has stored objective' : ''}`);
        
        // Route to team orchestration with stored objective if user's message is short/generic
        // Otherwise use user's current message as the objective
        const currentObjective = text.length < 50 && teamObjective ? teamObjective : text;
        if (teamObjective && currentObjective === teamObjective) {
          logger.info(`[AgentController] 📋 Using stored team objective: ${teamObjective.substring(0, 100)}...`);
        }
        
        return await handleTeamOrchestration(req, res, {
          text: currentObjective,
          conversationId,
          parentMessageId,
          teamAgents,
          userId,
          teamObjective, // Pass stored objective for reference
        });
      }
    } catch (teamCheckError) {
      logger.error('[AgentController] Error checking for team agents:', teamCheckError);
      // Continue with normal flow on error
    }
  }

  // Create handler to avoid capturing the entire parent scope
  let getReqData = (data = {}) => {
    for (let key in data) {
      if (key === 'userMessage') {
        userMessage = data[key];
        userMessageId = data[key].messageId;
      } else if (key === 'userMessagePromise') {
        userMessagePromise = data[key];
      } else if (key === 'responseMessageId') {
        responseMessageId = data[key];
      } else if (key === 'promptTokens') {
        promptTokens = data[key];
      } else if (key === 'sender') {
        sender = data[key];
      } else if (key === 'abortKey') {
        abortKey = data[key];
      } else if (!conversationId && key === 'conversationId') {
        conversationId = data[key];
      }
    }
  };

  // Create a function to handle final cleanup
  const performCleanup = () => {
    logger.debug('[AgentController] Performing cleanup');
    if (Array.isArray(cleanupHandlers)) {
      for (const handler of cleanupHandlers) {
        try {
          if (typeof handler === 'function') {
            handler();
          }
        } catch (e) {
          logger.error('[AgentController] Error in cleanup handler', e);
        }
      }
    }

    // Clean up abort controller
    if (abortKey) {
      logger.debug('[AgentController] Cleaning up abort controller');
      cleanupAbortController(abortKey);
    }

    // Dispose client properly
    if (client) {
      disposeClient(client);
    }

    // Clear all references
    client = null;
    getReqData = null;
    userMessage = null;
    getAbortData = null;
    endpointOption.agent = null;
    endpointOption = null;
    cleanupHandlers = null;
    userMessagePromise = null;

    // Clear request data map
    if (requestDataMap.has(req)) {
      requestDataMap.delete(req);
    }
    logger.debug('[AgentController] Cleanup completed');
  };

  try {
    let prelimAbortController = new AbortController();
    const prelimCloseHandler = createCloseHandler(prelimAbortController);
    res.on('close', prelimCloseHandler);
    const removePrelimHandler = (manual) => {
      try {
        prelimCloseHandler(manual);
        res.removeListener('close', prelimCloseHandler);
      } catch (e) {
        logger.error('[AgentController] Error removing close listener', e);
      }
    };
    cleanupHandlers.push(removePrelimHandler);
    // Log agent info before initialization
    if (drSterlingActivated) {
      logger.info(`[AgentController] 🎩 About to initialize client with agent_id: ${endpointOption?.agent_id}`);
    }
    
    /** @type {{ client: TAgentClient; userMCPAuthMap?: Record<string, Record<string, string>> }} */
    const result = await initializeClient({
      req,
      res,
      endpointOption,
      signal: prelimAbortController.signal,
    });
    
    // Log what agent was actually used
    if (drSterlingActivated && result?.client) {
      const usedAgent = result.client.options?.agent;
      logger.info(`[AgentController] 🎩 Client initialized. Agent used: ${usedAgent?.name || usedAgent?.id || 'unknown'}`);
      logger.debug(`[AgentController] 🎩 Client agent tools: ${JSON.stringify(usedAgent?.tools || [])}`);
    }
    
    if (prelimAbortController.signal?.aborted) {
      prelimAbortController = null;
      throw new Error('Request was aborted before initialization could complete');
    } else {
      prelimAbortController = null;
      removePrelimHandler(true);
      cleanupHandlers.pop();
    }
    client = result.client;

    // Register client with finalization registry if available
    if (clientRegistry) {
      clientRegistry.register(client, { userId }, client);
    }

    // Store request data in WeakMap keyed by req object
    requestDataMap.set(req, { client });

    // Use WeakRef to allow GC but still access content if it exists
    const contentRef = new WeakRef(client.contentParts || []);

    // Minimize closure scope - only capture small primitives and WeakRef
    getAbortData = () => {
      // Dereference WeakRef each time
      const content = contentRef.deref();

      return {
        sender,
        content: content || [],
        userMessage,
        promptTokens,
        conversationId,
        userMessagePromise,
        messageId: responseMessageId,
        parentMessageId: overrideParentMessageId ?? userMessageId,
      };
    };

    const { abortController, onStart } = createAbortController(req, res, getAbortData, getReqData);
    const closeHandler = createCloseHandler(abortController);
    res.on('close', closeHandler);
    cleanupHandlers.push(() => {
      try {
        res.removeListener('close', closeHandler);
      } catch (e) {
        logger.error('[AgentController] Error removing close listener', e);
      }
    });

    const messageOptions = {
      user: userId,
      onStart,
      getReqData,
      isContinued,
      isRegenerate,
      editedContent,
      conversationId,
      parentMessageId,
      abortController,
      overrideParentMessageId,
      isEdited: !!editedContent,
      userMCPAuthMap: result.userMCPAuthMap,
      responseMessageId: editedResponseMessageId,
      progressOptions: {
        res,
      },
    };

    let response = await client.sendMessage(text, messageOptions);

    // Extract what we need and immediately break reference
    const messageId = response.messageId;
    const endpoint = endpointOption.endpoint;
    response.endpoint = endpoint;

    // Store database promise locally
    const databasePromise = response.databasePromise;
    delete response.databasePromise;

    // Resolve database-related data
    const { conversation: convoData = {} } = await databasePromise;
    const conversation = { ...convoData };
    conversation.title =
      conversation && !conversation.title ? null : conversation?.title || 'New Chat';

    // Process files if needed
    if (req.body.files && client.options?.attachments) {
      userMessage.files = [];
      const messageFiles = new Set(req.body.files.map((file) => file.file_id));
      for (let attachment of client.options.attachments) {
        if (messageFiles.has(attachment.file_id)) {
          userMessage.files.push({ ...attachment });
        }
      }
      delete userMessage.image_urls;
    }

    // Get the final conversationId from conversation data (important for first message when conversationId was null)
    const finalConversationId = conversation.conversationId || conversationId;
    
    // Team creation from Dr. Sterling's output is now handled via explicit user approval
    // through the TeamIndicator component in the frontend, which calls /api/teams/:conversationId/parse
    
    // Trigger team creation for PDF/document files if not already created
    // Use finalConversationId which is set even on first message
    logger.info(`[AgentController] Checking team creation - finalConversationId: ${finalConversationId}, files: ${req.body.files ? req.body.files.length : 0}`);
    
    if (finalConversationId && req.body.files && req.body.files.length > 0) {
      // Run team creation in background after response
      const teamCreationUserId = userId;
      const teamCreationFiles = [...req.body.files];
      const teamCreationReq = { user: req.user, config: req.config };
      
      setImmediate(async () => {
        try {
          const { getTeamAgents } = require('~/models/Conversation');
          const existingTeamAgents = await getTeamAgents(finalConversationId);
          
          logger.info(`[AgentController] Existing team agents: ${existingTeamAgents ? existingTeamAgents.length : 0}`);
          
          // Only create team if it doesn't exist yet
          if (!existingTeamAgents || existingTeamAgents.length === 0) {
            const documentFiles = teamCreationFiles.filter(
              (file) =>
                file.type === 'application/pdf' ||
                file.type?.startsWith('application/') ||
                file.type?.startsWith('text/')
            );

            logger.info(`[AgentController] Document files found: ${documentFiles.length}, types: ${teamCreationFiles.map(f => f.type).join(', ')}`);

            if (documentFiles.length > 0) {
              logger.info(
                `[AgentController] Triggering team creation for conversation ${finalConversationId} with ${documentFiles.length} document file(s)`,
              );
              
              const { analyzeFile, createTeamAgents, COORDINATOR_AGENT_ID } = require('~/server/services/Teams');
              const { saveTeamAgents } = require('~/models/Conversation');
              const { getFiles } = require('~/models/File');
              
              // Get file objects from database
              const fileIds = documentFiles.map((f) => f.file_id);
              logger.info(`[AgentController] Looking for files with IDs: ${fileIds.join(', ')}`);
              const dbFiles = await getFiles({ file_id: { $in: fileIds } }, null, {});
              logger.info(`[AgentController] Found ${dbFiles.length} files in database`);
              
              // Process first document file
              if (dbFiles.length > 0) {
                const firstFile = dbFiles[0];
                logger.info(`[AgentController] Processing file: ${firstFile.filename}, path: ${firstFile.filepath}`);
                
                const { createCoordinatorAgent } = require('~/server/services/Teams');
                await createCoordinatorAgent(teamCreationUserId);
                
                // Get file from filesystem for analysis
                const fs = require('fs');
                const path = require('path');
                const filePath = path.join(process.cwd(), firstFile.filepath);
                
                logger.info(`[AgentController] Full file path: ${filePath}, exists: ${fs.existsSync(filePath)}`);
                
                if (fs.existsSync(filePath)) {
                  const file = {
                    path: filePath,
                    originalname: firstFile.filename,
                    mimetype: firstFile.type,
                  };
                  
                  logger.info(`[AgentController] Starting file analysis...`);
                  const analysis = await analyzeFile({ req: teamCreationReq, file, file_id: firstFile.file_id });
                  logger.info(`[AgentController] Analysis complete. Roles: ${analysis.roles?.length || 0}`);
                  
                  const teamAgents = await createTeamAgents({
                    conversationId: finalConversationId,
                    roles: analysis.roles,
                  });
                  await saveTeamAgents(finalConversationId, teamAgents, COORDINATOR_AGENT_ID, firstFile.file_id);
                  logger.info(
                    `[AgentController] ✅ Successfully created ${teamAgents.length} team agents for conversation ${finalConversationId}`,
                  );
                } else {
                  logger.error(`[AgentController] File not found at path: ${filePath}`);
                }
              } else {
                logger.warn(`[AgentController] No files found in database for IDs: ${fileIds.join(', ')}`);
              }
            }
          } else {
            logger.info(`[AgentController] Team already exists with ${existingTeamAgents.length} agents`);
          }
        } catch (teamError) {
          logger.error('[AgentController] Error creating team agents:', teamError);
          // Don't fail the request if team creation fails
        }
      });
    }

    // Only send if not aborted
    if (!abortController.signal.aborted) {
      // Create a new response object with minimal copies
      const finalResponse = { ...response };

      sendEvent(res, {
        final: true,
        conversation,
        title: conversation.title,
        requestMessage: userMessage,
        responseMessage: finalResponse,
      });
      res.end();

      // Save the message if needed
      if (client.savedMessageIds && !client.savedMessageIds.has(messageId)) {
        await saveMessage(
          req,
          { ...finalResponse, user: userId },
          { context: 'api/server/controllers/agents/request.js - response end' },
        );
      }
    }
    // Edge case: sendMessage completed but abort happened during sendCompletion
    // We need to ensure a final event is sent
    else if (!res.headersSent && !res.finished) {
      logger.debug(
        '[AgentController] Handling edge case: `sendMessage` completed but aborted during `sendCompletion`',
      );

      const finalResponse = { ...response };
      finalResponse.error = true;

      sendEvent(res, {
        final: true,
        conversation,
        title: conversation.title,
        requestMessage: userMessage,
        responseMessage: finalResponse,
        error: { message: 'Request was aborted during completion' },
      });
      res.end();
    }

    // Save user message if needed
    if (!client.skipSaveUserMessage) {
      await saveMessage(req, userMessage, {
        context: "api/server/controllers/agents/request.js - don't skip saving user message",
      });
    }

    // Add title if needed - extract minimal data
    if (addTitle && parentMessageId === Constants.NO_PARENT && newConvo) {
      addTitle(req, {
        text,
        response: { ...response },
        client,
      })
        .then(() => {
          logger.debug('[AgentController] Title generation started');
        })
        .catch((err) => {
          logger.error('[AgentController] Error in title generation', err);
        })
        .finally(() => {
          logger.debug('[AgentController] Title generation completed');
          performCleanup();
        });
    } else {
      performCleanup();
    }
  } catch (error) {
    // Handle error without capturing much scope
    handleAbortError(res, req, error, {
      conversationId,
      sender,
      messageId: responseMessageId,
      parentMessageId: overrideParentMessageId ?? userMessageId ?? parentMessageId,
      userMessageId,
    })
      .catch((err) => {
        logger.error('[api/server/controllers/agents/request] Error in `handleAbortError`', err);
      })
      .finally(() => {
        performCleanup();
      });
  }
};

module.exports = AgentController;
