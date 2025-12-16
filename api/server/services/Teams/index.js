const {
  createCoordinatorAgent,
  getCoordinatorAgent,
  COORDINATOR_AGENT_ID,
  ORCHESTRATOR_ANTHROPIC_MODEL,
} = require('./createCoordinatorAgent');

const DEFAULT_ANTHROPIC_MODEL = ORCHESTRATOR_ANTHROPIC_MODEL;
const { analyzeFile } = require('./analyzeFile');
const { createTeamAgents, createTeamEdges } = require('./createTeamAgents');
const { FILE_ANALYSIS_PROMPT, COORDINATOR_SYSTEM_PROMPT } = require('./prompts');
const {
  getDrSterlingAgent,
  isDrSterlingAgent,
  parseTeamFromMarkdown,
  convertParsedTeamToAgents,
  isTeamRelatedMessage,
  mergeTeamMembers,
  DR_STERLING_AGENT_ID,
} = require('./drSterlingAgent');
const { extractTeamCompositionWithLLM, validateAndEnhanceTeam } = require('./extractTeamWithLLM');
const {
  executeLeadAnalysis,
  executeSpecialist,
  synthesizeDeliverableStreaming,
  orchestrateTeamResponse,
  shouldUseTeamOrchestration,
  // QA Gate functions
  executeQAGate,
  executeQAReview,
  executeQARemediation,
  resumeQAGate,
  // State management
  getOrchestrationState,
  saveOrchestrationState,
  clearOrchestrationState,
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
  isTeamRelatedMessage,
  mergeTeamMembers,
  DR_STERLING_AGENT_ID,

  // LLM-based extraction
  extractTeamCompositionWithLLM,
  validateAndEnhanceTeam,

  // Team Orchestration
  executeLeadAnalysis,
  executeSpecialist,
  synthesizeDeliverableStreaming,
  orchestrateTeamResponse,
  shouldUseTeamOrchestration,

  // QA Gate (Phase 5: Enhanced QA Gate Protocol)
  executeQAGate,
  executeQAReview,
  executeQARemediation,
  resumeQAGate,

  // State management for resumable orchestrations
  getOrchestrationState,
  saveOrchestrationState,
  clearOrchestrationState,

  // Prompts
  FILE_ANALYSIS_PROMPT,
  COORDINATOR_SYSTEM_PROMPT,
};
