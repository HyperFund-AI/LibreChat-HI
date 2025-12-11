const { logger } = require('@librechat/data-schemas');
const { createContentAggregator } = require('@librechat/agents');
const {
  validateAgentModel,
  getCustomEndpointConfig,
  createSequentialChainEdges,
} = require('@librechat/api');
const {
  Constants,
  EModelEndpoint,
  isAgentsEndpoint,
  getResponseSender,
} = require('librechat-data-provider');
const {
  createToolEndCallback,
  getDefaultHandlers,
} = require('~/server/controllers/agents/callbacks');
const { initializeAgent } = require('~/server/services/Endpoints/agents/agent');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { loadAgentTools } = require('~/server/services/ToolService');
const AgentClient = require('~/server/controllers/agents/client');
const { getAgent } = require('~/models/Agent');
const { logViolation } = require('~/cache');
const { getTeamAgents, getConvo } = require('~/models/Conversation');

/**
 * @param {AbortSignal} signal
 */
function createToolLoader(signal) {
  /**
   * @param {object} params
   * @param {ServerRequest} params.req
   * @param {ServerResponse} params.res
   * @param {string} params.agentId
   * @param {string[]} params.tools
   * @param {string} params.provider
   * @param {string} params.model
   * @param {AgentToolResources} params.tool_resources
   * @returns {Promise<{
   * tools: StructuredTool[],
   * toolContextMap: Record<string, unknown>,
   * userMCPAuthMap?: Record<string, Record<string, string>>
   * } | undefined>}
   */
  return async function loadTools({ req, res, agentId, tools, provider, model, tool_resources }) {
    const agent = { id: agentId, tools, provider, model };
    try {
      return await loadAgentTools({
        req,
        res,
        agent,
        signal,
        tool_resources,
      });
    } catch (error) {
      logger.error('Error loading tools for agent ' + agentId, error);
    }
  };
}

const initializeClient = async ({ req, res, signal, endpointOption }) => {
  if (!endpointOption) {
    throw new Error('Endpoint option not provided');
  }
  const appConfig = req.config;

  // TODO: use endpointOption to determine options/modelOptions
  /** @type {Array<UsageMetadata>} */
  const collectedUsage = [];
  /** @type {ArtifactPromises} */
  const artifactPromises = [];
  const { contentParts, aggregateContent } = createContentAggregator();
  const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });
  const eventHandlers = getDefaultHandlers({
    res,
    aggregateContent,
    toolEndCallback,
    collectedUsage,
  });

  if (!endpointOption.agent) {
    throw new Error('No agent promise provided');
  }

  logger.debug(
    `[initializeClient] Awaiting agent promise. agent_id in endpointOption: ${endpointOption.agent_id}`,
  );
  const primaryAgent = await endpointOption.agent;
  delete endpointOption.agent;
  if (!primaryAgent) {
    logger.error(
      `[initializeClient] Primary agent is NULL! agent_id was: ${endpointOption.agent_id}`,
    );
    throw new Error('Agent not found');
  }

  logger.debug(
    `[initializeClient] Primary agent resolved: id=${primaryAgent.id}, name=${primaryAgent.name}, tools=${JSON.stringify(primaryAgent.tools || [])}`,
  );
  logger.debug(
    `[initializeClient] Agent instructions length: ${primaryAgent.instructions?.length || 0} characters`,
  );

  // Check if this is Dr. Sterling (for debugging)
  if (primaryAgent.id === 'dr_sterling_coordinator' || primaryAgent.isTeamCoordinator) {
    logger.info(`[initializeClient] 🎩 Dr. Sterling agent detected!`);
    logger.info(
      `[initializeClient] 🎩 Instructions preview: ${primaryAgent.instructions?.substring(0, 200) || 'NO INSTRUCTIONS!'}`,
    );
    if (!primaryAgent.instructions || primaryAgent.instructions.length === 0) {
      logger.error(`[initializeClient] 🎩 WARNING: Dr. Sterling has NO instructions!`);
    }
  }

  const modelsConfig = await getModelsConfig(req);
  const validationResult = await validateAgentModel({
    req,
    res,
    modelsConfig,
    logViolation,
    agent: primaryAgent,
  });

  if (!validationResult.isValid) {
    throw new Error(validationResult.error?.message);
  }

  const agentConfigs = new Map();
  const allowedProviders = new Set(appConfig?.endpoints?.[EModelEndpoint.agents]?.allowedProviders);

  const loadTools = createToolLoader(signal);
  /** @type {Array<MongoFile>} */
  const requestFiles = req.body.files ?? [];
  /** @type {string} */
  const conversationId = req.body.conversationId;

  // Check if conversation has team agents and load them
  let teamAgents = null;
  if (conversationId) {
    try {
      const conversation = await getConvo(req.user.id, conversationId);
      if (
        conversation?.teamAgents &&
        Array.isArray(conversation.teamAgents) &&
        conversation.teamAgents.length > 0
      ) {
        teamAgents = conversation.teamAgents;
        logger.debug(
          `[initializeClient] Found ${teamAgents.length} team agents in conversation ${conversationId}`,
        );
      }
    } catch (error) {
      logger.error('[initializeClient] Error loading team agents:', error);
      // Continue without team agents if there's an error
    }
  }

  const primaryConfig = await initializeAgent({
    req,
    res,
    loadTools,
    requestFiles,
    conversationId,
    agent: primaryAgent,
    endpointOption,
    allowedProviders,
    isInitialAgent: true,
  });

  const agent_ids = primaryConfig.agent_ids;
  let userMCPAuthMap = primaryConfig.userMCPAuthMap;

  async function processAgent(agentId) {
    const agent = await getAgent({ id: agentId });
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const validationResult = await validateAgentModel({
      req,
      res,
      agent,
      modelsConfig,
      logViolation,
    });

    if (!validationResult.isValid) {
      throw new Error(validationResult.error?.message);
    }

    const config = await initializeAgent({
      req,
      res,
      agent,
      loadTools,
      requestFiles,
      conversationId,
      endpointOption,
      allowedProviders,
    });
    if (userMCPAuthMap != null) {
      Object.assign(userMCPAuthMap, config.userMCPAuthMap ?? {});
    } else {
      userMCPAuthMap = config.userMCPAuthMap;
    }
    agentConfigs.set(agentId, config);
  }

  // Load team agents if they exist
  if (teamAgents && teamAgents.length > 0) {
    for (const teamAgent of teamAgents) {
      // Create ephemeral agent configuration from team agent data
      const ephemeralAgent = {
        id: teamAgent.agentId,
        name: teamAgent.name,
        description: `Team member: ${teamAgent.role}`,
        instructions: teamAgent.instructions,
        provider: teamAgent.provider || primaryAgent.provider,
        model: teamAgent.model || primaryAgent.model,
        model_parameters: primaryAgent.model_parameters || {},
        tools: [],
        edges: [],
      };

      try {
        const config = await initializeAgent({
          req,
          res,
          agent: ephemeralAgent,
          loadTools,
          requestFiles,
          conversationId,
          endpointOption,
          allowedProviders,
        });
        if (userMCPAuthMap != null) {
          Object.assign(userMCPAuthMap, config.userMCPAuthMap ?? {});
        } else {
          userMCPAuthMap = config.userMCPAuthMap;
        }
        agentConfigs.set(teamAgent.agentId, config);
        logger.debug(
          `[initializeClient] Loaded team agent: ${teamAgent.agentId} (${teamAgent.role})`,
        );
      } catch (error) {
        logger.error(`[initializeClient] Error loading team agent ${teamAgent.agentId}:`, error);
        // Continue loading other agents even if one fails
      }
    }
  }

  let edges = primaryConfig.edges;
  const checkAgentInit = (agentId) => agentId === primaryConfig.id || agentConfigs.has(agentId);

  // Add edges for team agents if they exist
  if (teamAgents && teamAgents.length > 0) {
    // Create edges from primary agent to all team agents
    for (const teamAgent of teamAgents) {
      if (!edges) {
        edges = [];
      }
      edges.push({
        from: primaryConfig.id,
        to: teamAgent.agentId,
      });
    }
    // Create bidirectional edges between team agents for collaboration
    for (let i = 0; i < teamAgents.length; i++) {
      for (let j = i + 1; j < teamAgents.length; j++) {
        edges.push({
          from: teamAgents[i].agentId,
          to: teamAgents[j].agentId,
        });
        edges.push({
          from: teamAgents[j].agentId,
          to: teamAgents[i].agentId,
        });
      }
    }
  }

  if ((edges?.length ?? 0) > 0) {
    for (const edge of edges) {
      if (Array.isArray(edge.to)) {
        for (const to of edge.to) {
          if (checkAgentInit(to)) {
            continue;
          }
          await processAgent(to);
        }
      } else if (typeof edge.to === 'string' && checkAgentInit(edge.to)) {
        continue;
      } else if (typeof edge.to === 'string') {
        await processAgent(edge.to);
      }

      if (Array.isArray(edge.from)) {
        for (const from of edge.from) {
          if (checkAgentInit(from)) {
            continue;
          }
          await processAgent(from);
        }
      } else if (typeof edge.from === 'string' && checkAgentInit(edge.from)) {
        continue;
      } else if (typeof edge.from === 'string') {
        await processAgent(edge.from);
      }
    }
  }

  /** @deprecated Agent Chain */
  if (agent_ids?.length) {
    for (const agentId of agent_ids) {
      if (checkAgentInit(agentId)) {
        continue;
      }
      await processAgent(agentId);
    }

    const chain = await createSequentialChainEdges([primaryConfig.id].concat(agent_ids), '{convo}');
    edges = edges ? edges.concat(chain) : chain;
  }

  primaryConfig.edges = edges;

  let endpointConfig = appConfig.endpoints?.[primaryConfig.endpoint];
  if (!isAgentsEndpoint(primaryConfig.endpoint) && !endpointConfig) {
    try {
      endpointConfig = getCustomEndpointConfig({
        endpoint: primaryConfig.endpoint,
        appConfig,
      });
    } catch (err) {
      logger.error(
        '[api/server/controllers/agents/client.js #titleConvo] Error getting custom endpoint config',
        err,
      );
    }
  }

  const sender =
    primaryAgent.name ??
    getResponseSender({
      ...endpointOption,
      model: endpointOption.model_parameters.model,
      modelDisplayLabel: endpointConfig?.modelDisplayLabel,
      modelLabel: endpointOption.model_parameters.modelLabel,
    });

  const client = new AgentClient({
    req,
    res,
    sender,
    contentParts,
    agentConfigs,
    eventHandlers,
    collectedUsage,
    aggregateContent,
    artifactPromises,
    agent: primaryConfig,
    spec: endpointOption.spec,
    iconURL: endpointOption.iconURL,
    attachments: primaryConfig.attachments,
    endpointType: endpointOption.endpointType,
    resendFiles: primaryConfig.resendFiles ?? true,
    maxContextTokens: primaryConfig.maxContextTokens,
    endpoint:
      primaryConfig.id === Constants.EPHEMERAL_AGENT_ID
        ? primaryConfig.endpoint
        : EModelEndpoint.agents,
  });

  return { client, userMCPAuthMap };
};

module.exports = { initializeClient };
