const { z } = require('zod');
const { fixJSONObject } = require('~/server/utils/jsonRepair');
const { betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');
const Anthropic = require('@anthropic-ai/sdk');
const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint } = require('librechat-data-provider');
const { getUserKey } = require('~/server/services/UserService');
const { FAST_ANTRHOPIC_MODEL } = require('./drSterlingAgent');

const zProjectSchema = z.object({
  projectName: z.string().min(1).describe('Project name (string)'),
  complexity: z
    .enum(['LOW', 'MODERATE', 'HIGH', 'VERY_HIGH'])
    .describe('Project complexity: LOW|MODERATE|HIGH|VERY_HIGH'),
  teamSize: z.number().min(1).describe('Team size (number, must match members.length)'),
  members: z
    .array(
      z.object({
        name: z.string().min(1).describe('Full Name'),
        role: z.string().min(1).describe('Role Title'),
        tier: z.enum(['3', '4', '5']).describe('Tier: 3|4|5'),
        expertise: z.string().min(1).describe('Expertise areas'),
        behavioralLevel: z
          .enum(['NONE', 'ENTRY-MODERATE', 'MODERATE-EXPERT', 'EXPERT'])
          .describe('Behavioral level: NONE|ENTRY–MODERATE|MODERATE–EXPERT|EXPERT'),
        instructions: z
          .string()
          .min(1)
          .describe(
            'Complete full specification including all sections (Professional Foundation, Expertise Architecture, Operational Parameters, Excellence Framework)',
          ),
      }),
    )
    .min(1)
    .describe('Array of team members'),
});
//.refine((data) => data.teamSize === data.members.length, {
//  message: 'teamSize must exactly match members.length',
//  path: ['teamSize'],
//});

/**
 * Extracts team composition from all team-related messages using LLM
 * @param {Array<Object>} teamRelatedMessages - Array of messages with team specifications
 * @param {string} userId - User ID for API key retrieval
 * @returns {Promise<Object>} Extracted team with members array
 */
const extractTeamCompositionWithLLM = async (teamRelatedMessages, userId) => {
  try {
    logger.info(
      `[extractTeamCompositionWithLLM] Extracting team from ${teamRelatedMessages.length} messages using LLM`,
      teamRelatedMessages,
    );

    // Get Anthropic API key
    const { ANTHROPIC_API_KEY } = process.env;
    const isUserProvided = ANTHROPIC_API_KEY === 'user_provided';
    const anthropicApiKey = isUserProvided
      ? await getUserKey({ userId, name: EModelEndpoint.anthropic })
      : ANTHROPIC_API_KEY;

    if (!anthropicApiKey) {
      throw new Error('Anthropic API key not available');
    }

    // Combine all team-related messages
    const combinedText = teamRelatedMessages
      .map(
        (msg, idx) =>
          `--- Message ${idx + 1} (${new Date(msg.createdAt).toISOString()}) ---\n${msg.text}`,
      )
      .join('\n\n');

    // Limit text to avoid token limits (keep last 100000 characters - most recent is most important)
    const maxTextLength = 100000;
    const truncatedText =
      combinedText.length > maxTextLength
        ? combinedText.substring(combinedText.length - maxTextLength) +
          '\n\n[Earlier content truncated...]'
        : combinedText;

    const systemPrompt = `You are an expert at extracting structured team information from Dr. Sterling's team specifications.

Your task is to extract the FINAL, APPROVED team composition from all provided messages. When multiple messages are provided, use the LATEST information for each team member.

Extract the complete team composition including:
1. Project name
2. Complexity level
3. Team size
4. All team members with their complete information

Respond in JSON format according to schema.

IMPORTANT:
- Include ALL team members mentioned in the LATEST messages
- For each member, include their COMPLETE specification (all sections from the SUPERHUMAN SPECIFICATIONS)
- If a member appears in multiple messages, use the LATEST version
- The "instructions" field should contain the FULL specification block including all subsections
- Ensure all 8 members are included if mentioned in the latest message`;

    const userMessage = `Extract the final approved team composition from these messages:

${truncatedText}

Respond in JSON format according to schema.`;

    const client = new Anthropic({ apiKey: anthropicApiKey });

    const response = await client.beta.messages.parse({
      model: FAST_ANTRHOPIC_MODEL,
      max_tokens: 16000,
      temperature: 0.3, // Lower temperature for more consistent extraction
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userMessage,
        },
      ],
      output_format: betaZodOutputFormat(zProjectSchema),
    });

    const responseText = response.content[0]?.text || '';
    logger.debug('[extractTeamCompositionWithLLM] Received LLM response');

    // Parse JSON from response (handle markdown code blocks)
    let extractedTeam;
    try {
      // Try to extract JSON from markdown code blocks if present
      const jsonMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      const jsonText = jsonMatch ? jsonMatch[1] : responseText;
      extractedTeam = JSON.parse(fixJSONObject(jsonText)); // zProjectSchema.parse();
    } catch (parseError) {
      logger.error('[extractTeamCompositionWithLLM] Error parsing JSON response:', parseError);
      logger.debug(
        '[extractTeamCompositionWithLLM] Response text:',
        responseText.substring(0, 500),
      );
      throw new Error(`Failed to parse LLM extraction result: ${parseError.message}`);
    }

    // Validate result structure
    if (!extractedTeam.members || !Array.isArray(extractedTeam.members)) {
      throw new Error('Invalid extraction result: missing or invalid members array');
    }

    if (extractedTeam.members.length === 0) {
      throw new Error('No team members extracted from messages');
    }

    // Validate each member has required fields
    for (const member of extractedTeam.members) {
      if (!member.name || !member.role) {
        throw new Error(
          `Invalid member structure: missing name or role in ${JSON.stringify(member)}`,
        );
      }
      if (!member.instructions || member.instructions.trim().length < 100) {
        logger.warn(
          `[extractTeamCompositionWithLLM] Member ${member.name} has short instructions (${member.instructions?.length || 0} chars), may be incomplete`,
        );
      }
    }

    logger.info(
      `[extractTeamCompositionWithLLM] Successfully extracted team: ${extractedTeam.members.length} members, project: ${extractedTeam.projectName || 'N/A'}`,
    );

    return extractedTeam;
  } catch (error) {
    logger.error('[extractTeamCompositionWithLLM] Error extracting team with LLM:', error);
    throw error;
  }
};

/**
 * Validates and enhances extracted team using regex as safety check
 * @param {Object} extractedTeam - Team extracted by LLM
 * @param {Array<Object>} teamRelatedMessages - Original messages for validation
 * @returns {Object} Validated and enhanced team
 */
const validateAndEnhanceTeam = (extractedTeam, teamRelatedMessages) => {
  logger.info(`[validateAndEnhanceTeam] Validating ${extractedTeam.members.length} members`);

  // Combine messages for regex validation
  const combinedText = teamRelatedMessages.map((msg) => msg.text).join('\n\n');

  // Count members mentioned in messages using regex as validation
  const memberNamePattern = /###\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g;
  const mentionedNames = new Set();
  let match;
  while ((match = memberNamePattern.exec(combinedText)) !== null) {
    const name = match[1].trim();
    if (name.length > 3 && name.length < 50) {
      mentionedNames.add(name);
    }
  }

  logger.info(
    `[validateAndEnhanceTeam] Found ${mentionedNames.size} unique member names in messages via regex`,
  );

  // Check if LLM missed any members
  const extractedNames = new Set(extractedTeam.members.map((m) => m.name));
  const missingNames = Array.from(mentionedNames).filter((name) => {
    // Fuzzy match - check if any extracted name contains or is contained in mentioned name
    return !Array.from(extractedNames).some(
      (extracted) =>
        name.toLowerCase().includes(extracted.toLowerCase()) ||
        extracted.toLowerCase().includes(name.toLowerCase()),
    );
  });

  if (missingNames.length > 0) {
    logger.warn(
      `[validateAndEnhanceTeam] Potential missing members detected: ${missingNames.join(', ')}`,
    );
    logger.warn(`[validateAndEnhanceTeam] Extracted: ${Array.from(extractedNames).join(', ')}`);
  }

  // Enhance members with additional data from regex if missing
  for (const member of extractedTeam.members) {
    // If instructions are too short, try to find full spec in messages
    if (!member.instructions || member.instructions.length < 500) {
      const memberSpecPattern = new RegExp(
        `###\\s+${member.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=###\\s+[A-Z]|##\\s+|$)`,
        'i',
      );

      for (const msg of teamRelatedMessages) {
        const specMatch = msg.text.match(memberSpecPattern);
        if (specMatch && specMatch[0].length > member.instructions?.length) {
          member.instructions = specMatch[0].trim();
          logger.info(
            `[validateAndEnhanceTeam] Enhanced instructions for ${member.name} from ${member.instructions.length} to ${specMatch[0].length} chars`,
          );
          break;
        }
      }
    }
  }

  return extractedTeam;
};

/**
 * Uses LLM to check if user message is a confirmation to proceed with team creation
 * @param {string} userMessage - The user's message
 * @param {string} assistantResponse - Dr. Sterling's response (for context)
 * @param {string} userId - User ID for API key retrieval
 * @returns {Promise<boolean>} True if user confirmed team creation
 */
const checkUserConfirmation = async (userMessage, assistantResponse, userId) => {
  try {
    // Get Anthropic API key
    const { ANTHROPIC_API_KEY } = process.env;
    const isUserProvided = ANTHROPIC_API_KEY === 'user_provided';
    const anthropicApiKey = isUserProvided
      ? await getUserKey({ userId, name: EModelEndpoint.anthropic })
      : ANTHROPIC_API_KEY;

    if (!anthropicApiKey) {
      logger.warn('[checkUserConfirmation] No API key available, falling back to false');
      return false;
    }

    const client = new Anthropic({ apiKey: anthropicApiKey });

    const systemPrompt = `You are analyzing a conversation where a user is reviewing a team specification from Dr. Sterling.
Your task is to determine if the user's message is a CONFIRMATION to proceed with creating the team.

A confirmation means the user is approving/accepting the proposed team and wants to proceed.
Examples of confirmations: "I confirm", "looks good, proceed", "create the team", "let's go", "approved", "yes, create it"
Examples of NON-confirmations: "what about X?", "can you change Y?", "I have a question", "not sure about this"

Respond with ONLY "YES" or "NO".`;

    const response = await client.messages.create({
      model: FAST_ANTRHOPIC_MODEL,
      max_tokens: 10,
      temperature: 0,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `User message: "${userMessage}"\n\nAssistant response preview (first 500 chars): "${assistantResponse.substring(0, 500)}"\n\nIs this a confirmation to proceed with team creation? Answer YES or NO only.`,
        },
      ],
    });

    const answer = response.content[0]?.text?.trim().toUpperCase() || 'NO';
    const isConfirmed = answer === 'YES';
    
    logger.info(`[checkUserConfirmation] User message: "${userMessage.substring(0, 50)}..." -> ${isConfirmed ? 'CONFIRMED' : 'NOT CONFIRMED'}`);
    
    return isConfirmed;
  } catch (error) {
    logger.error('[checkUserConfirmation] Error checking confirmation:', error.message);
    return false; // Default to not confirmed on error
  }
};

module.exports = {
  extractTeamCompositionWithLLM,
  validateAndEnhanceTeam,
  checkUserConfirmation,
};
