const { handleError } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const {
  EndpointURLs,
  EModelEndpoint,
  isAgentsEndpoint,
  parseCompactConvo,
} = require('librechat-data-provider');
const azureAssistants = require('~/server/services/Endpoints/azureAssistants');
const assistants = require('~/server/services/Endpoints/assistants');
const { processFiles } = require('~/server/services/Files/process');
const anthropic = require('~/server/services/Endpoints/anthropic');
const bedrock = require('~/server/services/Endpoints/bedrock');
const openAI = require('~/server/services/Endpoints/openAI');
const agents = require('~/server/services/Endpoints/agents');
const custom = require('~/server/services/Endpoints/custom');
const google = require('~/server/services/Endpoints/google');

// Dr. Sterling activation pattern - "Dr. Sterling, this is [Name]"
const DR_STERLING_ACTIVATION_PATTERN = /^dr\.?\s*sterling,?\s*this\s+is\s+/i;
const DR_STERLING_AGENT_ID = 'dr_sterling_coordinator';

const buildFunction = {
  [EModelEndpoint.openAI]: openAI.buildOptions,
  [EModelEndpoint.google]: google.buildOptions,
  [EModelEndpoint.custom]: custom.buildOptions,
  [EModelEndpoint.agents]: agents.buildOptions,
  [EModelEndpoint.bedrock]: bedrock.buildOptions,
  [EModelEndpoint.azureOpenAI]: openAI.buildOptions,
  [EModelEndpoint.anthropic]: anthropic.buildOptions,
  [EModelEndpoint.assistants]: assistants.buildOptions,
  [EModelEndpoint.azureAssistants]: azureAssistants.buildOptions,
};

async function buildEndpointOption(req, res, next) {
  const { endpoint, endpointType } = req.body;
  let parsedBody;
  try {
    parsedBody = parseCompactConvo({ endpoint, endpointType, conversation: req.body });
  } catch (error) {
    logger.warn(
      `Error parsing conversation for endpoint ${endpoint}${error?.message ? `: ${error.message}` : ''}`,
    );
    return handleError(res, { text: 'Error parsing conversation' });
  }

  const appConfig = req.config;
  if (appConfig.modelSpecs?.list && appConfig.modelSpecs?.enforce) {
    /** @type {{ list: TModelSpec[] }}*/
    const { list } = appConfig.modelSpecs;
    const { spec } = parsedBody;

    if (!spec) {
      return handleError(res, { text: 'No model spec selected' });
    }

    const currentModelSpec = list.find((s) => s.name === spec);
    if (!currentModelSpec) {
      return handleError(res, { text: 'Invalid model spec' });
    }

    if (endpoint !== currentModelSpec.preset.endpoint) {
      return handleError(res, { text: 'Model spec mismatch' });
    }

    try {
      currentModelSpec.preset.spec = spec;
      parsedBody = parseCompactConvo({
        endpoint,
        endpointType,
        conversation: currentModelSpec.preset,
      });
      if (currentModelSpec.iconURL != null && currentModelSpec.iconURL !== '') {
        parsedBody.iconURL = currentModelSpec.iconURL;
      }
    } catch (error) {
      logger.error(`Error parsing model spec for endpoint ${endpoint}`, error);
      return handleError(res, { text: 'Error parsing model spec' });
    }
  } else if (parsedBody.spec && appConfig.modelSpecs?.list) {
    // Non-enforced mode: if spec is selected, derive iconURL from model spec
    const modelSpec = appConfig.modelSpecs.list.find((s) => s.name === parsedBody.spec);
    if (modelSpec?.iconURL) {
      parsedBody.iconURL = modelSpec.iconURL;
    }
  }

  try {
    const isAgents =
      isAgentsEndpoint(endpoint) || req.baseUrl.startsWith(EndpointURLs[EModelEndpoint.agents]);
    
    // Check for Dr. Sterling activation phrase BEFORE building agent options
    const userText = req.body.text || '';
    if (DR_STERLING_ACTIVATION_PATTERN.test(userText)) {
      const nameMatch = userText.match(/^dr\.?\s*sterling,?\s*this\s+is\s+([^.!?\n]+)/i);
      const userName = nameMatch ? nameMatch[1].trim() : 'User';
      
      logger.info(`[buildEndpointOption] 🎩 Dr. Sterling activation detected! User: ${userName}`);
      
      // Ensure Dr. Sterling agent exists before we try to load it
      try {
        const { getDrSterlingAgent } = require('~/server/services/Teams');
        const drSterlingAgent = await getDrSterlingAgent(req.user.id);
        if (drSterlingAgent) {
          logger.info(`[buildEndpointOption] 🎩 Dr. Sterling agent ready: id=${drSterlingAgent.id}, name=${drSterlingAgent.name}`);
          logger.info(`[buildEndpointOption] 🎩 Instructions length: ${drSterlingAgent.instructions?.length || 0} characters`);
          logger.debug(`[buildEndpointOption] 🎩 Instructions preview: ${drSterlingAgent.instructions?.substring(0, 100) || 'EMPTY'}...`);
        } else {
          logger.error(`[buildEndpointOption] 🎩 getDrSterlingAgent returned null/undefined!`);
        }
      } catch (sterlingError) {
        logger.error(`[buildEndpointOption] 🎩 Error ensuring Dr. Sterling exists:`, sterlingError);
        // Continue anyway - the loadAgent will handle the error
      }
      
      // Override agent_id to Dr. Sterling - this will be used by loadAgent
      req.body.agent_id = DR_STERLING_AGENT_ID;
      parsedBody.agent_id = DR_STERLING_AGENT_ID;
      
      // IMPORTANT: Force the endpoint to 'agents' so that loadAgent uses our agent_id
      // Otherwise, buildOptions will use EPHEMERAL_AGENT_ID for non-agents endpoints
      req.body.endpoint = EModelEndpoint.agents;
      parsedBody.endpoint = EModelEndpoint.agents;
      
      // Disable ephemeral agent tools (web search, etc.) when switching to Dr. Sterling
      if (req.body.ephemeralAgent) {
        req.body.ephemeralAgent.web_search = false;
        req.body.ephemeralAgent.file_search = false;
        req.body.ephemeralAgent.execute_code = false;
      }
      
      // Store activation context for later use
      req.drSterlingContext = {
        activated: true,
        userName,
        activationPhrase: userText,
      };
      
      logger.info(`[buildEndpointOption] 🎩 Agent ID set to: ${DR_STERLING_AGENT_ID}`);
      logger.info(`[buildEndpointOption] 🎩 Endpoint forced to: ${EModelEndpoint.agents}`);
    }
    
    // Re-check isAgents after potential Dr. Sterling activation
    const finalIsAgents = req.drSterlingContext?.activated || isAgents;
    const finalEndpoint = req.drSterlingContext?.activated ? EModelEndpoint.agents : endpoint;
    
    const builder = finalIsAgents
      ? (...args) => buildFunction[EModelEndpoint.agents](req, ...args)
      : buildFunction[endpointType ?? endpoint];
    
    if (req.drSterlingContext?.activated) {
      logger.info(`[buildEndpointOption] 🎩 Using agents builder for Dr. Sterling`);
    }

    // TODO: use object params
    req.body.endpointOption = await builder(finalEndpoint, parsedBody, endpointType);

    if (req.body.files && !finalIsAgents) {
      req.body.endpointOption.attachments = processFiles(req.body.files);
    }

    next();
  } catch (error) {
    logger.error(
      `Error building endpoint option for endpoint ${endpoint} with type ${endpointType}`,
      error,
    );
    return handleError(res, { text: 'Error building endpoint option' });
  }
}

module.exports = buildEndpointOption;
