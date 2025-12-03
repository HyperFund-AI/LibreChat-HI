import {
  parseConvo,
  EModelEndpoint,
  isAssistantsEndpoint,
  isAgentsEndpoint,
} from 'librechat-data-provider';
import type { TConversation, EndpointSchemaKey } from 'librechat-data-provider';
import { getLocalStorageItems } from './localStorage';

/**
 * Upgrades Claude models to the latest Opus 4.5 for Anthropic endpoint
 * Also normalizes any Opus 4.5 model names with dates to the base name
 */
function upgradeClaudeModel(
  model: string | undefined,
  endpoint: EModelEndpoint | null,
): string | undefined {
  if (!model || endpoint !== EModelEndpoint.anthropic) {
    return model;
  }

  // Preserve Opus 4.5 model names with dates - don't normalize them
  // Anthropic requires date suffixes for valid model names
  // Only normalize if it's the base name without date
  if (model.startsWith('claude-opus-4-5-')) {
    return model; // Keep dated version as-is
  }
  
  // If it's claude-opus-4-5 without date, upgrade to dated version
  if (model === 'claude-opus-4-5') {
    return 'claude-opus-4-5-20250420';
  }

  // Upgrade old Claude 3.5 models
  if (
    model === 'claude-3-5-sonnet-latest' ||
    model === 'claude-3-5-sonnet-20241022' ||
    model === 'claude-3-5-sonnet-20240620' ||
    model.startsWith('claude-3-5-sonnet')
  ) {
    return 'claude-opus-4-5';
  }

  // Upgrade Haiku models to Opus
  if (
    model === 'claude-haiku-4-5' ||
    model === 'claude-haiku-4-5-20251001' ||
    model.startsWith('claude-haiku-4-5') ||
    model.startsWith('claude-3-5-haiku') ||
    model.startsWith('claude-haiku-3')
  ) {
    return 'claude-opus-4-5';
  }

  // Upgrade Sonnet 4.5 to Opus 4.5
  if (
    model === 'claude-sonnet-4-5' ||
    model === 'claude-sonnet-4-5-20250929' ||
    model.startsWith('claude-sonnet-4-5')
  ) {
    return 'claude-opus-4-5';
  }

  return model;
}

const buildDefaultConvo = ({
  models,
  conversation,
  endpoint = null,
  lastConversationSetup,
}: {
  models: string[];
  conversation: TConversation;
  endpoint?: EModelEndpoint | null;
  lastConversationSetup: TConversation | null;
}): TConversation => {
  const { lastSelectedModel, lastSelectedTools } = getLocalStorageItems();
  const endpointType = lastConversationSetup?.endpointType ?? conversation.endpointType;

  if (!endpoint) {
    return {
      ...conversation,
      endpointType,
      endpoint,
    };
  }

  const availableModels = models;
  let model = lastConversationSetup?.model ?? lastSelectedModel?.[endpoint] ?? '';

  // Upgrade Claude models to Opus 4.5
  model = upgradeClaudeModel(model, endpoint) ?? '';

  const secondaryModel: string | null =
    endpoint === EModelEndpoint.gptPlugins
      ? (lastConversationSetup?.agentOptions?.model ?? lastSelectedModel?.secondaryModel ?? null)
      : null;

  let possibleModels: string[], secondaryModels: string[];

  if (availableModels.includes(model)) {
    possibleModels = [model, ...availableModels];
  } else {
    possibleModels = [...availableModels];
  }

  if (secondaryModel != null && secondaryModel !== '' && availableModels.includes(secondaryModel)) {
    secondaryModels = [secondaryModel, ...availableModels];
  } else {
    secondaryModels = [...availableModels];
  }

  const convo = parseConvo({
    endpoint: endpoint as EndpointSchemaKey,
    endpointType: endpointType as EndpointSchemaKey,
    conversation: lastConversationSetup,
    possibleValues: {
      models: possibleModels,
      secondaryModels,
    },
  });

  const defaultConvo = {
    ...conversation,
    ...convo,
    endpointType,
    endpoint,
  };

  // Upgrade Claude model in the final conversation object
  if (endpoint === EModelEndpoint.anthropic) {
    if (defaultConvo.model) {
      defaultConvo.model = upgradeClaudeModel(defaultConvo.model, endpoint) ?? defaultConvo.model;
    } else {
      // If no model is set, use the default Claude Opus 4.5 with date suffix
      // Anthropic requires date suffixes for valid model names
      defaultConvo.model = 'claude-opus-4-5-20250420';
    }

    // Enable web search by default if not explicitly set
    if (defaultConvo.web_search === undefined || defaultConvo.web_search === null) {
      defaultConvo.web_search = true;
    }
  }

  // Ensures assistant_id is always defined
  const assistantId = convo?.assistant_id ?? conversation?.assistant_id ?? '';
  const defaultAssistantId = lastConversationSetup?.assistant_id ?? '';
  if (isAssistantsEndpoint(endpoint) && !defaultAssistantId && assistantId) {
    defaultConvo.assistant_id = assistantId;
  }

  // Ensures agent_id is always defined
  const agentId = convo?.agent_id ?? '';
  const defaultAgentId = lastConversationSetup?.agent_id ?? '';
  if (isAgentsEndpoint(endpoint) && !defaultAgentId && agentId) {
    defaultConvo.agent_id = agentId;
  }

  defaultConvo.tools = lastConversationSetup?.tools ?? lastSelectedTools ?? defaultConvo.tools;

  return defaultConvo;
};

export default buildDefaultConvo;
