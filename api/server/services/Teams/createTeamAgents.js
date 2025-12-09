const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint } = require('librechat-data-provider');
const { DEFAULT_ANTHROPIC_MODEL } = require('./createCoordinatorAgent');

/**
 * Creates ephemeral team agent configurations based on analysis results
 * @param {Object} params - Parameters object
 * @param {string} params.conversationId - The conversation ID
 * @param {Array} params.roles - Array of role objects from analysis
 * @param {string} params.provider - Provider to use (default: Anthropic)
 * @param {string} params.model - Model to use (default: DEFAULT_ANTHROPIC_MODEL)
 * @returns {Array} Array of team agent configurations
 */
const createTeamAgents = async ({ conversationId, roles, provider = EModelEndpoint.anthropic, model = DEFAULT_ANTHROPIC_MODEL }) => {
  try {
    logger.debug(`[createTeamAgents] Creating ${roles.length} team agents for conversation ${conversationId}`);

    const teamAgents = roles.map((role, index) => {
      const timestamp = Date.now();
      const agentId = `team_${conversationId}_${role.role.toLowerCase().replace(/\s+/g, '_')}_${timestamp}`;

      return {
        agentId,
        role: role.role,
        name: role.name,
        instructions: role.instructions,
        provider,
        model,
        responsibilities: role.responsibilities || '',
      };
    });

    logger.info(`[createTeamAgents] Created ${teamAgents.length} team agent configurations`);
    return teamAgents;
  } catch (error) {
    logger.error('[createTeamAgents] Error creating team agents:', error);
    throw error;
  }
};

/**
 * Creates edges for agent collaboration
 * All team agents can communicate with each other and the coordinator
 * @param {Array} teamAgents - Array of team agent configurations
 * @param {string} coordinatorAgentId - The coordinator agent ID
 * @returns {Array} Array of edge configurations
 */
const createTeamEdges = (teamAgents, coordinatorAgentId) => {
  const edges = [];
  const teamAgentIds = teamAgents.map((agent) => agent.agentId);

  // Create edges from coordinator to all team agents
  for (const agentId of teamAgentIds) {
    edges.push({
      from: coordinatorAgentId,
      to: agentId,
    });
  }

  // Create bidirectional edges between all team agents for collaboration
  for (let i = 0; i < teamAgentIds.length; i++) {
    for (let j = i + 1; j < teamAgentIds.length; j++) {
      edges.push({
        from: teamAgentIds[i],
        to: teamAgentIds[j],
      });
      edges.push({
        from: teamAgentIds[j],
        to: teamAgentIds[i],
      });
    }
  }

  return edges;
};

module.exports = {
  createTeamAgents,
  createTeamEdges,
};

