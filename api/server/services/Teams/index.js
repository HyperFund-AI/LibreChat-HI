const { createCoordinatorAgent, getCoordinatorAgent } = require('./createCoordinatorAgent');
const { analyzeFile } = require('./analyzeFile');
const { createTeamAgents, createTeamEdges } = require('./createTeamAgents');
const { FILE_ANALYSIS_PROMPT, COORDINATOR_SYSTEM_PROMPT } = require('./prompts');

module.exports = {
  createCoordinatorAgent,
  getCoordinatorAgent,
  analyzeFile,
  createTeamAgents,
  createTeamEdges,
  FILE_ANALYSIS_PROMPT,
  COORDINATOR_SYSTEM_PROMPT,
};

