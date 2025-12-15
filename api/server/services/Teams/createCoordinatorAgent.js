const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint, anthropicSettings } = require('librechat-data-provider');
const { createAgent, getAgent } = require('~/models/Agent');
const { COORDINATOR_SYSTEM_PROMPT } = require('./prompts');

const COORDINATOR_AGENT_ID = 'team_coordinator_agent';
const COORDINATOR_ANTHROPIC_MODEL = 'claude-sonnet-4-5';

/**
 * Creates or retrieves the Team Coordinator agent
 * This agent is responsible for analyzing files and creating team structures
 * @param {string} userId - The user ID to use as author (typically system/admin user)
 * @returns {Promise<Object>} The coordinator agent
 */
const createCoordinatorAgent = async (userId) => {
  try {
    // Check if coordinator agent already exists
    const existingAgent = await getAgent({ id: COORDINATOR_AGENT_ID });
    if (existingAgent) {
      logger.debug('[createCoordinatorAgent] Coordinator agent already exists');
      return existingAgent;
    }

    // Create new coordinator agent
    const agentData = {
      id: COORDINATOR_AGENT_ID,
      name: 'Team Coordinator',
      description:
        'Coordinates team creation by analyzing documents and identifying required professional roles',
      instructions: COORDINATOR_SYSTEM_PROMPT,
      provider: EModelEndpoint.anthropic,
      model: COORDINATOR_ANTHROPIC_MODEL,
      author: userId,
      isTeamCoordinator: true,
      category: 'system',
      tools: [],
      model_parameters: {
        temperature: 0.7,
        maxOutputTokens: 4096,
      },
    };

    const agent = await createAgent(agentData);
    logger.info('[createCoordinatorAgent] Created coordinator agent successfully');
    return agent;
  } catch (error) {
    logger.error('[createCoordinatorAgent] Error creating coordinator agent:', error);
    throw error;
  }
};

/**
 * Gets the Team Coordinator agent
 * @returns {Promise<Object|null>} The coordinator agent or null if not found
 */
const getCoordinatorAgent = async () => {
  try {
    return await getAgent({ id: COORDINATOR_AGENT_ID });
  } catch (error) {
    logger.error('[getCoordinatorAgent] Error getting coordinator agent:', error);
    return null;
  }
};

module.exports = {
  createCoordinatorAgent,
  getCoordinatorAgent,
  COORDINATOR_AGENT_ID,
  COORDINATOR_ANTHROPIC_MODEL,
};
