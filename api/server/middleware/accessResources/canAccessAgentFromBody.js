const { logger } = require('@librechat/data-schemas');
const { Constants, isAgentsEndpoint, ResourceType, EModelEndpoint } = require('librechat-data-provider');
const { canAccessResource } = require('./canAccessResource');
const { getAgent } = require('~/models/Agent');

// Dr. Sterling activation pattern - "Dr. Sterling, this is [Name]"
const DR_STERLING_ACTIVATION_PATTERN = /^dr\.?\s*sterling,?\s*this\s+is\s+/i;
const DR_STERLING_AGENT_ID = 'dr_sterling_coordinator';

/**
 * Agent ID resolver function for agent_id from request body
 * Resolves custom agent ID (e.g., "agent_abc123") to MongoDB ObjectId
 * This is used specifically for chat routes where agent_id comes from request body
 *
 * @param {string} agentCustomId - Custom agent ID from request body
 * @returns {Promise<Object|null>} Agent document with _id field, or null if not found
 */
const resolveAgentIdFromBody = async (agentCustomId) => {
  // Handle ephemeral agents - they don't need permission checks
  if (agentCustomId === Constants.EPHEMERAL_AGENT_ID) {
    return null; // No permission check needed for ephemeral agents
  }

  return await getAgent({ id: agentCustomId });
};

/**
 * Middleware factory that creates middleware to check agent access permissions from request body.
 * This middleware is specifically designed for chat routes where the agent_id comes from req.body
 * instead of route parameters.
 *
 * @param {Object} options - Configuration options
 * @param {number} options.requiredPermission - The permission bit required (1=view, 2=edit, 4=delete, 8=share)
 * @returns {Function} Express middleware function
 *
 * @example
 * // Basic usage for agent chat (requires VIEW permission)
 * router.post('/chat',
 *   canAccessAgentFromBody({ requiredPermission: PermissionBits.VIEW }),
 *   buildEndpointOption,
 *   chatController
 * );
 */
const canAccessAgentFromBody = (options) => {
  const { requiredPermission } = options;

  // Validate required options
  if (!requiredPermission || typeof requiredPermission !== 'number') {
    throw new Error('canAccessAgentFromBody: requiredPermission is required and must be a number');
  }

  return async (req, res, next) => {
    try {
      const { endpoint, agent_id, text } = req.body;
      let agentId = agent_id;
      let finalEndpoint = endpoint;

      // Check for Dr. Sterling activation phrase BEFORE checking agent_id
      // This must happen before buildEndpointOption middleware runs
      const userText = text || '';
      if (DR_STERLING_ACTIVATION_PATTERN.test(userText)) {
        const nameMatch = userText.match(/^dr\.?\s*sterling,?\s*this\s+is\s+([^.!?\n]+)/i);
        const userName = nameMatch ? nameMatch[1].trim() : 'User';
        
        logger.info(`[canAccessAgentFromBody] 🎩 Dr. Sterling activation detected! User: ${userName}`);
        
        // Ensure Dr. Sterling agent exists before we try to check permissions
        try {
          const { getDrSterlingAgent } = require('~/server/services/Teams');
          const drSterlingAgent = await getDrSterlingAgent(req.user.id);
          if (!drSterlingAgent) {
            logger.error(`[canAccessAgentFromBody] 🎩 Failed to get/create Dr. Sterling agent`);
            return res.status(500).json({
              error: 'Internal Server Error',
              message: 'Failed to initialize Dr. Sterling agent',
            });
          }
          logger.info(`[canAccessAgentFromBody] 🎩 Dr. Sterling agent ready: id=${drSterlingAgent.id}`);
        } catch (sterlingError) {
          logger.error(`[canAccessAgentFromBody] 🎩 Error ensuring Dr. Sterling exists:`, sterlingError);
          return res.status(500).json({
            error: 'Internal Server Error',
            message: 'Failed to initialize Dr. Sterling agent',
          });
        }
        
        // Set agent_id and endpoint for Dr. Sterling BEFORE validation
        req.body.agent_id = DR_STERLING_AGENT_ID;
        req.body.endpoint = EModelEndpoint.agents;
        agentId = DR_STERLING_AGENT_ID;
        finalEndpoint = EModelEndpoint.agents;
        
        // Store activation context for later use
        req.drSterlingContext = {
          activated: true,
          userName,
          activationPhrase: userText,
        };
        
        logger.info(`[canAccessAgentFromBody] 🎩 Agent ID set to: ${DR_STERLING_AGENT_ID}`);
        logger.info(`[canAccessAgentFromBody] 🎩 Endpoint forced to: ${EModelEndpoint.agents}`);
      }

      if (!isAgentsEndpoint(finalEndpoint)) {
        agentId = Constants.EPHEMERAL_AGENT_ID;
      }

      if (!agentId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'agent_id is required in request body',
        });
      }

      // Skip permission checks for ephemeral agents
      if (agentId === Constants.EPHEMERAL_AGENT_ID) {
        return next();
      }

      const agentAccessMiddleware = canAccessResource({
        resourceType: ResourceType.AGENT,
        requiredPermission,
        resourceIdParam: 'agent_id', // This will be ignored since we use custom resolver
        idResolver: () => resolveAgentIdFromBody(agentId),
      });

      const tempReq = {
        ...req,
        params: {
          ...req.params,
          agent_id: agentId,
        },
      };

      return agentAccessMiddleware(tempReq, res, next);
    } catch (error) {
      logger.error('Failed to validate agent access permissions', error);
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to validate agent access permissions',
      });
    }
  };
};

module.exports = {
  canAccessAgentFromBody,
};
