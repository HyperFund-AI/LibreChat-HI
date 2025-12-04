const { removeNullishValues, anthropicSettings } = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');
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

  // If it's claude-opus-4-5 without date, upgrade to the available dated version
  if (model === 'claude-opus-4-5') {
    return 'claude-opus-4-5-20251101';
  }

  // Upgrade old Claude 3.5 models to Opus 4.5 with date
  // Use the available dated version: claude-opus-4-5-20251101
  if (
    model === 'claude-3-5-sonnet-latest' ||
    model === 'claude-3-5-sonnet-20241022' ||
    model === 'claude-3-5-sonnet-20240620' ||
    model.startsWith('claude-3-5-sonnet')
  ) {
    return 'claude-opus-4-5-20251101';
  }

  // Upgrade Haiku models to Opus 4.5 with date
  if (
    model === 'claude-haiku-4-5' ||
    model === 'claude-haiku-4-5-20251001' ||
    model.startsWith('claude-haiku-4-5') ||
    model.startsWith('claude-3-5-haiku') ||
    model.startsWith('claude-haiku-3')
  ) {
    return 'claude-opus-4-5-20251101';
  }

  // Upgrade Sonnet 4.5 to Opus 4.5 with date
  if (
    model === 'claude-sonnet-4-5' ||
    model === 'claude-sonnet-4-5-20250929' ||
    model.startsWith('claude-sonnet-4-5')
  ) {
    return 'claude-opus-4-5-20251101';
  }

  return model;
}

const buildOptions = (endpoint, parsedBody) => {
  const {
    modelLabel,
    promptPrefix,
    system,
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

  // Use system field if promptPrefix is not set (system takes precedence for persona files)
  const finalPromptPrefix = promptPrefix || system || '';

  // Upgrade Claude models to Opus 4.5 if needed
  // IMPORTANT: Preserve dated model names - Anthropic requires date suffixes
  let finalModelLabel = modelLabel;
  if (modelOptions.model) {
    const originalModel = modelOptions.model;
    const upgraded = upgradeClaudeModel(modelOptions.model);
    // Only upgrade if the model actually changed AND the new model isn't just base name
    // If it's already a dated Opus 4.5, don't normalize it
    if (upgraded !== modelOptions.model) {
      logger.warn(
        `[MODEL UPGRADE] Anthropic: "${originalModel}" -> "${upgraded}" for endpoint ${endpoint}`,
      );
      modelOptions.model = upgraded;
    } else {
      logger.warn(`[MODEL] Anthropic: Using "${modelOptions.model}" for endpoint ${endpoint}`);
    }

    // Automatically set modelLabel for Opus 4.5 if not already set
    // This helps the model correctly identify itself, similar to Claude's web interface
    if (modelOptions.model.startsWith('claude-opus-4-5-') && !finalModelLabel) {
      finalModelLabel = 'Claude Opus 4.5';
    }
  }

  const endpointOption = removeNullishValues({
    endpoint,
    modelLabel: finalModelLabel,
    promptPrefix: finalPromptPrefix,
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
