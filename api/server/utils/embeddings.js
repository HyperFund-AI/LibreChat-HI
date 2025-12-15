const OpenAI = require('openai');

/**
 * Generates an embedding for the input text using OpenRouter.
 *
 * @param {string} text - The input text to generate an embedding for.
 * @param {string} [model] - The model to use for generating the embedding.
 *                           Defaults to process.env.EMBEDDINGS_MODEL or 'text-embedding-3-small'.
 * @returns {Promise<number[]>} The generated embedding.
 */
const getOpenRouterEmbedding = async (text, model) => {
  let apiKey = process.env.OPENROUTER_KEY;
  let baseURL = 'https://openrouter.ai/api/v1';
  let currentModel = model || process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small';

  if (!apiKey) {
    // Fallback to OpenAI Key
    apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      baseURL = 'https://api.openai.com/v1';
      currentModel = 'text-embedding-3-small';
    } else {
      throw new Error('Neither OPENROUTER_KEY nor OPENAI_API_KEY is set in environment variables');
    }
  }

  const openai = new OpenAI({
    apiKey,
    baseURL,
  });

  try {
    const response = await openai.embeddings.create({
      model: currentModel,
      input: text,
    });
    return response.data[0].embedding;
  } catch (error) {
    console.error('Error generating embedding via OpenRouter:', error);
    throw error;
  }
};

module.exports = { getOpenRouterEmbedding };
