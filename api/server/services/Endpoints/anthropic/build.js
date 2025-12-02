const { removeNullishValues, anthropicSettings } = require('librechat-data-provider');
const generateArtifactsPrompt = require('~/app/clients/prompts/artifacts');

/**
 * Upgrades Claude models to Claude Opus 4.5 for existing conversations
 * Also normalizes any Opus 4.5 model names with dates to the base name
 */
function upgradeClaudeModel(model) {
  if (!model || typeof model !== 'string') {
    return model;
  }

  // Normalize any Opus 4.5 model names (with or without dates) to the base name
  // This handles cases like claude-opus-4-5-20251101, claude-opus-4-5-20250420, etc.
  if (
    model === 'claude-opus-4-5' ||
    model.startsWith('claude-opus-4-5-') ||
    model === 'claude-opus-4-5-20250420' ||
    model === 'claude-opus-4-5-20251101'
  ) {
    return 'claude-opus-4-5';
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

const buildOptions = (endpoint, parsedBody) => {
  const {
    modelLabel,
    promptPrefix,
    maxContextTokens,
    fileTokenLimit,
    resendFiles = anthropicSettings.resendFiles.default,
    promptCache = anthropicSettings.promptCache.default,
    thinking = anthropicSettings.thinking.default,
    thinkingBudget = anthropicSettings.thinkingBudget.default,
    iconURL,
    greeting,
    spec,
    artifacts,
    ...modelOptions
  } = parsedBody;

  // Upgrade Claude models to Opus 4.5 if needed
  if (modelOptions.model) {
    modelOptions.model = upgradeClaudeModel(modelOptions.model);
  }

  const endpointOption = removeNullishValues({
    endpoint,
    modelLabel,
    promptPrefix,
    resendFiles,
    promptCache,
    thinking,
    thinkingBudget,
    iconURL,
    greeting,
    spec,
    maxContextTokens,
    fileTokenLimit,
    modelOptions,
  });

  if (typeof artifacts === 'string') {
    endpointOption.artifactsPrompt = generateArtifactsPrompt({ endpoint, artifacts });
  }

  return endpointOption;
};

module.exports = buildOptions;
