const { createCoordinatorAgent, getCoordinatorAgent, COORDINATOR_AGENT_ID, DEFAULT_ANTHROPIC_MODEL } = require('./createCoordinatorAgent');
const { analyzeFile } = require('./analyzeFile');
const { createTeamAgents, createTeamEdges } = require('./createTeamAgents');
const { FILE_ANALYSIS_PROMPT, COORDINATOR_SYSTEM_PROMPT } = require('./prompts');
const {
  getDrSterlingAgent,
  isDrSterlingAgent,
  parseTeamFromMarkdown,
  convertParsedTeamToAgents,
  DR_STERLING_AGENT_ID,
} = require('./drSterlingAgent');
const {
  executeLeadAnalysis,
  executeSpecialist,
  synthesizeDeliverableStreaming,
  orchestrateTeamResponse,
  shouldUseTeamOrchestration,
} = require('./orchestrator');

module.exports = {
  // Automatic team creation (simple mode)
  createCoordinatorAgent,
  getCoordinatorAgent,
  COORDINATOR_AGENT_ID,
  DEFAULT_ANTHROPIC_MODEL,
  analyzeFile,
  createTeamAgents,
  createTeamEdges,
  
  // Dr. Sterling interactive mode
  getDrSterlingAgent,
  isDrSterlingAgent,
  parseTeamFromMarkdown,
  convertParsedTeamToAgents,
  DR_STERLING_AGENT_ID,
  
  // Team Orchestration
  executeLeadAnalysis,
  executeSpecialist,
  synthesizeDeliverableStreaming,
  orchestrateTeamResponse,
  shouldUseTeamOrchestration,
  
  // Prompts
  FILE_ANALYSIS_PROMPT,
  COORDINATOR_SYSTEM_PROMPT,
};
