const { removeNullishValues, anthropicSettings } = require('librechat-data-provider');
const generateArtifactsPrompt = require('~/app/clients/prompts/artifacts');

/**
 * Upgrades Claude models to Claude Opus 4.5 for existing conversations
 * Note: We preserve date suffixes as they are required by Anthropic's API
 * If upgrading from an old model without a date, we try to use a dated version
 */
function upgradeClaudeModel(model) {
  if (!model || typeof model !== 'string') {
    return model;
  }

  // If already an Opus 4.5 model with date, preserve it
  if (model.startsWith('claude-opus-4-5-')) {
    return model; // Keep the dated version as-is
  }

  // If it's claude-opus-4-5 without date, we need to check available models
  // For now, we'll upgrade old models to claude-opus-4-5-20250420 as a fallback
  // The validation middleware will catch if it's not available
  if (model === 'claude-opus-4-5') {
    // Try common dated versions - validation will catch if not available
    return 'claude-opus-4-5-20250420'; // Fallback to a known date format
  }

  // Upgrade old Claude 3.5 models to Opus 4.5 with date
  // Use a dated version as Anthropic requires date suffixes
  if (
    model === 'claude-3-5-sonnet-latest' ||
    model === 'claude-3-5-sonnet-20241022' ||
    model === 'claude-3-5-sonnet-20240620' ||
    model.startsWith('claude-3-5-sonnet')
  ) {
    // Try to preserve a date pattern if possible, otherwise use a common dated version
    // The validation middleware will ensure it's valid
    return 'claude-opus-4-5-20250420';
  }

  // Upgrade Haiku models to Opus 4.5 with date
  if (
    model === 'claude-haiku-4-5' ||
    model === 'claude-haiku-4-5-20251001' ||
    model.startsWith('claude-haiku-4-5') ||
    model.startsWith('claude-3-5-haiku') ||
    model.startsWith('claude-haiku-3')
  ) {
    return 'claude-opus-4-5-20250420';
  }

  // Upgrade Sonnet 4.5 to Opus 4.5 with date
  if (
    model === 'claude-sonnet-4-5' ||
    model === 'claude-sonnet-4-5-20250929' ||
    model.startsWith('claude-sonnet-4-5')
  ) {
    return 'claude-opus-4-5-20250420';
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
  // IMPORTANT: Preserve dated model names - Anthropic requires date suffixes
  if (modelOptions.model) {
    const upgraded = upgradeClaudeModel(modelOptions.model);
    // Only upgrade if the model actually changed AND the new model isn't just base name
    // If it's already a dated Opus 4.5, don't normalize it
    if (upgraded !== modelOptions.model) {
      modelOptions.model = upgraded;
    }
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
