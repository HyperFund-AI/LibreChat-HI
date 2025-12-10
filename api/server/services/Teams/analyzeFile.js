const Anthropic = require('@anthropic-ai/sdk');
const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint } = require('librechat-data-provider');
const { getUserKey } = require('~/server/services/UserService');
const { parseText } = require('@librechat/api');
const { DEFAULT_ANTHROPIC_MODEL } = require('./createCoordinatorAgent');
const { FILE_ANALYSIS_PROMPT } = require('./prompts');

/**
 * Analyzes a file using the coordinator agent to identify required professional roles
 * @param {Object} params - Parameters object
 * @param {Object} params.req - Express request object
 * @param {Express.Multer.File} params.file - The uploaded file
 * @param {string} params.file_id - The file ID
 * @returns {Promise<Object>} Analysis result with document type and roles
 */
const analyzeFile = async ({ req, file, file_id }) => {
  try {
    logger.debug('[analyzeFile] Starting file analysis');

    // Extract text content from file
    let fileText;
    try {
      const parseResult = await parseText({ req, file, file_id });
      fileText = parseResult.text;
      if (!fileText || fileText.trim().length === 0) {
        throw new Error('File content is empty or could not be extracted');
      }
    } catch (error) {
      logger.error('[analyzeFile] Error parsing file text:', error);
      throw new Error(`Failed to extract text from file: ${error.message}`);
    }

    // Limit file text to avoid token limits (keep first 50000 characters)
    const maxTextLength = 50000;
    const truncatedText =
      fileText.length > maxTextLength
        ? fileText.substring(0, maxTextLength) + '\n\n[Content truncated...]'
        : fileText;

    // Get Anthropic API key
    const { ANTHROPIC_API_KEY } = process.env;
    const isUserProvided = ANTHROPIC_API_KEY === 'user_provided';
    const anthropicApiKey = isUserProvided
      ? await getUserKey({ userId: req.user.id, name: EModelEndpoint.anthropic })
      : ANTHROPIC_API_KEY;

    if (!anthropicApiKey) {
      throw new Error('Anthropic API key not available');
    }

    // Create Anthropic client
    const client = new Anthropic({ apiKey: anthropicApiKey });

    // Prepare the analysis prompt
    const userMessage = `${FILE_ANALYSIS_PROMPT}

Document Content:
\`\`\`
${truncatedText}
\`\`\`

Please analyze this document and return the JSON structure as specified above.`;

    // Call Anthropic API
    const response = await client.messages.create({
      model: DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 4096,
      temperature: 0.7,
      system: FILE_ANALYSIS_PROMPT,
      messages: [
        {
          role: 'user',
          content: userMessage,
        },
      ],
    });

    // Extract response text
    const responseText = response.content[0].text;
    logger.debug('[analyzeFile] Received response from coordinator agent');

    // Parse JSON from response (handle markdown code blocks)
    let analysisResult;
    try {
      // Try to extract JSON from markdown code blocks if present
      const jsonMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      const jsonText = jsonMatch ? jsonMatch[1] : responseText;
      analysisResult = JSON.parse(jsonText);
    } catch (parseError) {
      logger.error('[analyzeFile] Error parsing JSON response:', parseError);
      logger.debug('[analyzeFile] Response text:', responseText);
      throw new Error(`Failed to parse analysis result: ${parseError.message}`);
    }

    // Validate result structure
    if (!analysisResult.roles || !Array.isArray(analysisResult.roles)) {
      throw new Error('Invalid analysis result: missing or invalid roles array');
    }

    if (analysisResult.roles.length === 0) {
      throw new Error('No roles identified in document analysis');
    }

    // Limit to maximum 5 roles
    if (analysisResult.roles.length > 5) {
      analysisResult.roles = analysisResult.roles.slice(0, 5);
      logger.warn('[analyzeFile] Limited roles to maximum of 5');
    }

    // Validate each role has required fields
    for (const role of analysisResult.roles) {
      if (!role.role || !role.name || !role.instructions) {
        throw new Error(
          `Invalid role structure: missing required fields in role ${JSON.stringify(role)}`,
        );
      }
    }

    logger.info(
      `[analyzeFile] Successfully analyzed file. Document type: ${analysisResult.documentType}, Roles: ${analysisResult.roles.length}`,
    );

    return {
      documentType: analysisResult.documentType || 'Unknown',
      roles: analysisResult.roles,
    };
  } catch (error) {
    logger.error('[analyzeFile] Error analyzing file:', error);
    throw error;
  }
};

module.exports = {
  analyzeFile,
};
