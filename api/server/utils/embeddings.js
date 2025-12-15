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
  const apiKey = process.env.OPENROUTER_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_KEY is not set in environment variables');
  }

  const currentModel = model || process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small';

  const openai = new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
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
