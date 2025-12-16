const { fixJSONObject } = require('~/server/utils/jsonRepair');
const { betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');
const { z } = require('zod');
const { logger } = require('@librechat/data-schemas');
const Anthropic = require('@anthropic-ai/sdk');

const energySectorContext = `
## ENERGY SECTOR CONTEXT (Apply when relevant)

If the work involves energy, utilities, or infrastructure sectors:

### Domain Expertise Signals
Demonstrate deep sector knowledge through:
- Accurate regulatory terminology (FERC, NEPA, CPUC, PTC, ROD, EIS)
- Understanding of permitting complexity and timelines
- Knowledge of stakeholder dynamics (tribal nations, environmental groups, ratepayer advocates)
- Financial acumen (WACC, carrying costs, rate recovery, capital authorization)

### Capability Reference (NO CLIENT NAMES)
When referencing past work or capabilities, use ONLY generic references:
- "Major Western utilities"
- "Fortune 500 energy companies"
- "Leading engineering firms"
- "Infrastructure-focused organizations"

╔═══════════════════════════════════════════════════════════════════╗
║  NEVER mention: SDG&E, Xcel, Jacobs, Heartland, or any other     ║
║  specific client names. Use generic references only.              ║
╚═══════════════════════════════════════════════════════════════════╝
`;

const ORCHESTRATOR_ANTHROPIC_MODEL = 'claude-sonnet-4-5';

/**
 * In-memory cache for orchestration state when waiting for user input
 * Key: conversationId, Value: { state, timestamp }
 * Auto-expires after 30 minutes
 */
const orchestrationStateCache = new Map();
const ORCHESTRATION_STATE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Save orchestration state for a conversation
 */
const saveOrchestrationState = (conversationId, state) => {
  orchestrationStateCache.set(conversationId, {
    state,
    timestamp: Date.now(),
  });
  logger.info(`[orchestrationState] Saved state for conversation ${conversationId}`);
};

/**
 * Get and clear orchestration state for a conversation
 */
const getOrchestrationState = (conversationId) => {
  const cached = orchestrationStateCache.get(conversationId);
  if (!cached) {
    return null;
  }

  // Check if expired
  if (Date.now() - cached.timestamp > ORCHESTRATION_STATE_TTL) {
    orchestrationStateCache.delete(conversationId);
    logger.info(`[orchestrationState] State expired for conversation ${conversationId}`);
    return null;
  }

  // Return and keep state (don't clear yet - clear after successful resume)
  logger.info(`[orchestrationState] Retrieved state for conversation ${conversationId}`);
  return cached.state;
};

/**
 * Clear orchestration state for a conversation
 */
const clearOrchestrationState = (conversationId) => {
  orchestrationStateCache.delete(conversationId);
  logger.info(`[orchestrationState] Cleared state for conversation ${conversationId}`);
};

// Cleanup expired states periodically (every 5 minutes)
setInterval(
  () => {
    const now = Date.now();
    let cleared = 0;
    for (const [key, value] of orchestrationStateCache.entries()) {
      if (now - value.timestamp > ORCHESTRATION_STATE_TTL) {
        orchestrationStateCache.delete(key);
        cleared++;
      }
    }
    if (cleared > 0) {
      logger.debug(`[orchestrationState] Cleaned up ${cleared} expired states`);
    }
  },
  5 * 60 * 1000,
);

/**
 * Stream text incrementally to simulate typing effect
 * @param {string} text - Text to stream
 * @param {function} onStream - Callback for each chunk
 * @param {number} chunkSize - Characters per chunk (default: 5)
 * @param {number} delay - Delay between chunks in ms (default: 10)
 */
const streamTextIncrementally = async (text, onStream, chunkSize = 5, delay = 10) => {
  if (!onStream || !text) return;

  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    onStream(chunk);
    if (delay > 0 && i + chunkSize < text.length) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

/**
 * Tool definition for inter-specialist collaboration
 * Allows specialists to request information from colleagues mid-execution
 */
const REQUEST_FROM_COLLEAGUE_TOOL = {
  name: 'request_from_colleague',
  description:
    'Request specific information, data, or expert input from a colleague specialist. Use this when you need expertise outside your domain or need to verify/cross-reference information with another team member.',
  input_schema: {
    type: 'object',
    properties: {
      colleague_role: {
        type: 'string',
        description:
          'The role or expertise area of the colleague you need (e.g., "Engineering Technical Lead", "Environmental Specialist", "Regulatory Strategy"). Will be matched to the most relevant team member.',
      },
      question: {
        type: 'string',
        description:
          'Your specific question or information request. Be precise about what you need to know.',
      },
      context: {
        type: 'string',
        description:
          'Brief context about why you need this information and how it relates to your analysis.',
      },
    },
    required: ['colleague_role', 'question'],
  },
};

/**
 * Tool definition for asking the user/client for clarification
 * Allows specialists to request additional information from the user mid-execution
 */
const ASK_USER_TOOL = {
  name: 'ask_user_in_conversation',
  description:
    'Ask the user/client a question to get clarification or additional information needed for your analysis. Use this when critical information is missing from the original request, when you need to confirm assumptions, or when user input would significantly improve the quality of your deliverable.',
  input_schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description:
          'Your question to the user. Be clear and specific about what information you need and why it matters for the analysis.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of suggested answers or options to help guide the user response (e.g., ["Option A: Focus on cost", "Option B: Focus on timeline", "Option C: Balanced approach"]).',
      },
      importance: {
        type: 'string',
        enum: ['critical', 'important', 'helpful'],
        description:
          'How important is this information? "critical" = STOPS for user response, cannot proceed without it. "important" = STOPS for user response, significantly affects quality. "helpful" = proceed with assumptions, would improve but not essential.',
      },
    },
    required: ['question', 'importance'],
  },
};

/**
 * Helper to safely extract text content from a message
 * Handles both string content and array of content blocks
 */
const getMessageText = (content) => {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Handle array of content blocks (e.g., [{type: 'text', text: '...'}])
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block?.text) return block.text;
        if (block?.content) return getMessageText(block.content);
        return '';
      })
      .join('\n');
  }
  if (typeof content === 'object' && content.text) return content.text;
  return String(content);
};

const zLeadAnalysisSchema = z.object({
  analysis: z.string().describe('Brief analysis of what the objective requires (1-2 sentences)'),
  selectedSpecialists: z
    .array(
      z.number().int().min(1),
      'Selected specialists must be an array of non-negative integers',
    )
    .min(2)
    .max(10)
    .describe('Array of specialist IDs. MUST select at least 2-3 specialists, e.g., [1, 2, 3]'),
  assignments: z
    .record(z.number().nonnegative(), z.string().describe('Specific task for this specialist'))
    .describe('Specialist-to-task dictionary'),
  deliverableOutline: z.string().describe('"Brief outline of the final deliverable structure"'),
});

/**
 * Team Orchestrator - Smart Collaboration Flow with Visible Progress
 *
 * 1. Project Lead analyzes objective and selects relevant specialists
 * 2. Selected specialists contribute (visible collaboration)
 * 3. Project Lead synthesizes into ONE unified deliverable (streamed)
 */

/**
 * Phase 1: Lead analyzes objective and creates work plan
 */
const executeLeadAnalysis = async ({
  lead,
  userMessage,
  apiKey,
  teamAgents,
  onThinking,
  conversationHistory = [],
  fileContext = '',
  knowledgeContext = '',
}) => {
  const specialistList = teamAgents
    .filter((a) => parseInt(a.tier) !== 3)
    .map(
      (a, i) =>
        `${i + 1}. ${a.name} (${a.role}): ${a.expertise || a.responsibilities || 'Specialist'}`,
    )
    .join('\n');

  if (onThinking) {
    onThinking({
      agent: lead.name,
      action: 'analyzing',
      message: `Analyzing objective and identifying required expertise...`,
    });
  }

  // Build conversation history context for lead
  let conversationContext = '';
  if (conversationHistory && conversationHistory.length > 0) {
    const recentHistory = conversationHistory.slice(-10); // Last 10 messages for context
    const historyText = recentHistory
      .map((msg) => {
        const text = getMessageText(msg.content);
        const truncated = text.substring(0, 500);
        return `**${msg.role === 'user' ? 'User' : 'Assistant'}**: ${truncated}${text.length > 500 ? '...' : ''}`;
      })
      .join('\n\n');
    conversationContext = `\n\nConversation History:\n${historyText}`;
  }

  // Build file/knowledge context
  let additionalContext = '';
  if (fileContext && fileContext.trim()) {
    additionalContext += `\n\nAttached Files Context:\n${fileContext}`;
  }
  if (knowledgeContext && knowledgeContext.trim()) {
    additionalContext += `\n\nKnowledge Base Context:\n${knowledgeContext}`;
  }

  const systemPrompt = `You are ${lead.name}, ${lead.role}.

${lead.instructions || ''}

You are the Project Lead. Analyze the objective and decide which specialists are needed.

Available Specialists:
${specialistList}

IMPORTANT SELECTION REQUIREMENTS:
- You MUST select at least 2-3 specialists for every objective
- Select specialists whose expertise is genuinely needed for comprehensive analysis
- Consider different perspectives and areas of expertise
- Aim for 2-3 specialists minimum, but can select more if the objective requires it
- Each specialist should have a clear, distinct role in addressing the objective
- Consider conversation history and any attached files/knowledge base context when making assignments

Respond in JSON format according to schema.`;

  const client = new Anthropic({ apiKey });

  // Build full user message with all context
  const fullUserMessage = `Objective: ${userMessage}${additionalContext}${conversationContext}`;

  const response = await client.beta.messages.parse({
    model: ORCHESTRATOR_ANTHROPIC_MODEL,
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: fullUserMessage }],
    output_format: betaZodOutputFormat(zLeadAnalysisSchema),
  });

  const responseText = response.content[0]?.text || '';

  try {
    const jsonMatch = fixJSONObject(responseText);
    if (jsonMatch) {
      const jsonMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      const jsonText = jsonMatch ? jsonMatch[1] : responseText;
      const plan = JSON.parse(fixJSONObject(jsonText)); // zLeadAnalysisSchema.parse();
      console.log('Parsed ', plan);
      if (onThinking) {
        onThinking({
          agent: lead.name,
          action: 'planned',
          message: `Selected ${plan.selectedSpecialists?.length || 0} specialists for this task`,
        });
      }
      return plan;
    }
  } catch (e) {
    logger.warn('[executeLeadAnalysis] Could not parse JSON');
  }

  // Fallback: Select at least 2-3 specialists if parsing failed
  const availableSpecialists = teamAgents.filter((a) => parseInt(a.tier) !== 3);
  const allIndices = availableSpecialists.map((_, i) => i + 1);
  // Ensure we have at least 2-3 specialists selected
  const minSpecialists = Math.min(3, Math.max(2, availableSpecialists.length));
  const selectedIndices = allIndices.slice(0, minSpecialists);

  return {
    analysis: responseText,
    selectedSpecialists: selectedIndices,
    assignments: {},
    deliverableOutline: 'Comprehensive analysis',
  };
};

/**
 * Find the best matching colleague for a collaboration request
 * Matches by role, expertise, or name keywords
 */
const findColleague = (targetRole, availableSpecialists, excludeAgent = null) => {
  const searchTerms = targetRole.toLowerCase().split(/\s+/);

  // Score each specialist by how well they match the request
  const scored = availableSpecialists
    .filter((s) => !excludeAgent || s.name !== excludeAgent.name)
    .map((specialist) => {
      const searchableText =
        `${specialist.name} ${specialist.role} ${specialist.expertise || ''} ${specialist.responsibilities || ''}`.toLowerCase();

      let score = 0;
      for (const term of searchTerms) {
        if (searchableText.includes(term)) {
          score += term.length > 3 ? 2 : 1; // Longer terms get more weight
        }
      }

      // Exact role match gets bonus
      if (specialist.role.toLowerCase().includes(targetRole.toLowerCase())) {
        score += 5;
      }

      return { specialist, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.length > 0 ? scored[0].specialist : null;
};

/**
 * Execute a focused query to a colleague specialist
 * Streams the collaboration conversation so users see the back-and-forth
 */
const executeColleagueQuery = async ({
  colleague,
  question,
  context,
  requestingAgent,
  userMessage,
  apiKey,
  onThinking,
}) => {
  logger.info(
    `[executeColleagueQuery] ${requestingAgent.name} requesting info from ${colleague.name}: "${question.substring(0, 50)}..."`,
  );

  if (onThinking) {
    onThinking({
      agent: colleague.name,
      role: colleague.role,
      action: 'responding',
      message: `Responding to ${requestingAgent.name}'s question...`,
    });
  }

  const systemPrompt = `You are ${colleague.name}, a ${colleague.role}.

${colleague.instructions || ''}

Your expertise: ${colleague.expertise || colleague.responsibilities || 'Specialist'}

A colleague (${requestingAgent.name}, ${requestingAgent.role}) is asking you a direct question during a team collaboration.

IMPORTANT: Structure your response with a COLLABORATION_CONVO section that will be shown to stakeholders.

## REQUIRED DIALOGUE FORMAT

<COLLABORATION_CONVO>
**[Your Full Name, Credentials] — [Your Title]**

[Your dialogue - NO quote marks, conversational, addressing colleague by name]
</COLLABORATION_CONVO>

## EXAMPLE (follow this exactly):
<COLLABORATION_CONVO>
**Thomas Blackwood, PE — Engineering Technical Lead**

Patricia, hold on—what species are we dealing with? That's going to affect our route flexibility options. If it's desert tortoise or sage grouse, we've got established mitigation playbooks.
</COLLABORATION_CONVO>

## STRICT GUIDELINES:
- **WORD LIMIT: 100-200 words MAXIMUM** - Be concise like a real meeting exchange
- NO quote marks around dialogue - write naturally
- Address ${requestingAgent.name} directly by name
- Be conversational but professional
- Provide 1-2 specific data points, not exhaustive lists
- One focused point per response - don't try to cover everything

${energySectorContext}

`;

  const client = new Anthropic({ apiKey });

  let accumulatedText = '';
  let collabText = '';
  let lastCollabSent = '';

  const stream = client.messages.stream({
    model: colleague.model || ORCHESTRATOR_ANTHROPIC_MODEL,
    max_tokens: 1000,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `**Question from ${requestingAgent.name} (${requestingAgent.role}):**

${question}

${context ? `**Context:** ${context}` : ''}

**Original project objective:** ${userMessage}`,
      },
    ],
  });

  // Stream and extract COLLABORATION_CONVO in real-time
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.text) {
      const chunk = event.delta.text;
      accumulatedText += chunk;

      // Extract and stream COLLABORATION_CONVO
      const collabMatch = accumulatedText.match(
        /<COLLABORATION_CONVO>([\s\S]*?)(?:<\/COLLABORATION_CONVO>|$)/i,
      );
      if (collabMatch && collabMatch[1]) {
        const currentCollab = collabMatch[1].trim();

        // Stream updates when content grows
        if (currentCollab.length > lastCollabSent.length + 20 && onThinking) {
          collabText = currentCollab;
          lastCollabSent = currentCollab;

          onThinking({
            agent: colleague.name,
            role: colleague.role,
            action: 'collaboration',
            message: currentCollab.substring(0, 150) + (currentCollab.length > 150 ? '...' : ''),
            collaboration: currentCollab,
          });
        }
      }
    }
  }

  // Final extraction
  const finalCollabMatch = accumulatedText.match(
    /<COLLABORATION_CONVO>([\s\S]*?)<\/COLLABORATION_CONVO>/i,
  );
  if (finalCollabMatch) {
    collabText = finalCollabMatch[1].trim();
  } else {
    // Fallback to full response if no tags
    collabText = accumulatedText;
  }

  // Send final collaboration update
  if (onThinking && collabText && collabText !== lastCollabSent) {
    onThinking({
      agent: colleague.name,
      role: colleague.role,
      action: 'collaboration',
      message: collabText.substring(0, 150) + (collabText.length > 150 ? '...' : ''),
      collaboration: collabText,
    });
  }

  if (onThinking) {
    onThinking({
      agent: colleague.name,
      role: colleague.role,
      action: 'responded',
      message: `Provided information to ${requestingAgent.name}`,
    });
  }

  logger.info(
    `[executeColleagueQuery] ${colleague.name} responded with ${collabText.length} chars`,
  );

  return collabText;
};

/**
 * Phase 2: Execute selected specialists with visible progress and streaming thinking
 * Now supports collaborative chain - each specialist sees previous contributions
 * Supports tool-based collaboration to request info from colleagues
 */
const executeSpecialist = async ({
  agent,
  assignment,
  userMessage,
  apiKey,
  onThinking,
  previousContributions = [],
  conversationHistory = [],
  fileContext = '',
  knowledgeContext = '',
  availableSpecialists = [],
}) => {
  logger.info(
    `[executeSpecialist] Called for ${agent.name}, onThinking callback: ${onThinking ? 'present' : 'MISSING'}, previous contributions: ${previousContributions.length}, available colleagues: ${availableSpecialists.length}`,
  );
  logger.debug(
    `[executeSpecialist] Available specialists for ${agent.name}: ${availableSpecialists.map((s) => `${s.name} (${s.role})`).join(', ')}`,
  );

  if (onThinking) {
    onThinking({
      agent: agent.name,
      role: agent.role,
      action: 'working',
      message: assignment || `Analyzing from ${agent.role} perspective...`,
    });
  }

  // Build context from previous specialists' contributions
  let collaborationContext = '';
  if (previousContributions.length > 0) {
    const contributionsSummary = previousContributions
      .map((c) => `### ${c.name} (${c.role})\n${c.response}`)
      .join('\n\n---\n\n');
    collaborationContext = `
## Previous Team Contributions
The following specialists have already contributed their analysis. Review their work and build upon it - avoid repeating what they've covered, identify gaps, add your unique perspective, and connect your insights to theirs where relevant.

${contributionsSummary}

---
`;
  }

  // Build conversation history context
  let conversationContext = '';
  if (conversationHistory && conversationHistory.length > 0) {
    const recentHistory = conversationHistory.slice(-10); // Last 10 messages for context
    const historyText = recentHistory
      .map((msg) => {
        const text = getMessageText(msg.content);
        const truncated = text.substring(0, 500);
        return `**${msg.role === 'user' ? 'User' : 'Assistant'}**: ${truncated}${text.length > 500 ? '...' : ''}`;
      })
      .join('\n\n');
    conversationContext = `
## Conversation History
The following is the recent conversation context:

${historyText}

---
`;
  }

  // Build file/knowledge context
  let additionalContext = '';
  if (fileContext && fileContext.trim()) {
    additionalContext += `
## Attached Files Context
${fileContext}

---
`;
  }
  if (knowledgeContext && knowledgeContext.trim()) {
    additionalContext += `
## Knowledge Base Context
${knowledgeContext}

---
`;
  }

  // Build list of available colleagues for tool description
  const colleaguesList = availableSpecialists
    .filter((s) => s.name !== agent.name)
    .map((s) => `- ${s.name} (${s.role}): ${s.expertise || s.responsibilities || 'Specialist'}`)
    .join('\n');

  logger.debug(
    `[executeSpecialist] Colleagues list for ${agent.name} (excluding self): ${colleaguesList || 'NONE'}`,
  );

  const collaborationGuidelines =
    previousContributions.length > 0
      ? `
COLLABORATION GUIDELINES:
- Review the previous contributions carefully before starting
- Build upon and reference previous insights where relevant
- Avoid duplicating analysis that's already been done
- Identify gaps or areas the previous specialists may have missed
- Offer your unique perspective that complements their work
- If you disagree with a previous point, explain your reasoning
- Connect your analysis to the team's emerging picture`
      : '';

  // Build tool instructions - always include ask_user, conditionally include colleague collaboration
  const askUserInstructions = `
ASKING THE USER/CLIENT:
You have access to the 'ask_user_in_conversation' tool to request clarification or additional information from the user.

**When to ask the user:**
- Critical information is missing that significantly affects your analysis
- You need to confirm important assumptions before proceeding
- The user's preferences or priorities would change your recommendations
- Multiple valid approaches exist and user input would help choose

**How to ask effectively:**
- Be specific about what you need to know
- Indicate the importance level:
  - "critical" = STOPS analysis, question is presented to user, you MUST wait for their response
  - "important" = STOPS analysis, question is presented to user, wait for response (use for significant decisions)
  - "helpful" = nice to have, proceed with best judgment and stated assumptions
- Provide options when applicable to guide the user's response

**IMPORTANT behavior:**
- For "critical" or "important" questions: The system will STOP and present your question to the user. Wait for their response before proceeding. Do NOT make assumptions on these matters.
- For "helpful" questions: Proceed with reasonable assumptions, clearly stated in your output.`;

  const colleagueInstructions =
    availableSpecialists.length > 1
      ? `

TEAM COLLABORATION:
You have access to the 'request_from_colleague' tool to ask questions to other team members in real-time.

**When to consult colleagues:**
- You encounter something outside your expertise that another specialist can clarify
- You need to verify or cross-reference data/findings with a colleague
- You identify a gap that requires input from another domain (e.g., "What species are we dealing with?" to an environmental specialist)
- You want to validate your methodology or assumptions with a relevant expert

**How to collaborate effectively:**
- Be specific in your question - state exactly what you need to know
- Provide brief context about why you need this information
- After receiving colleague input, integrate their response into your analysis

**Available colleagues you can consult:**
${colleaguesList}

**IMPORTANT:** When you identify a genuine need for another specialist's input, USE THE TOOL immediately rather than making assumptions.`
      : '';

  const toolInstructions = `${askUserInstructions}${colleagueInstructions}`;

  logger.info(
    `[executeSpecialist] Tool instructions for ${agent.name}: ${toolInstructions ? 'INCLUDED' : 'NOT INCLUDED'} (availableSpecialists.length=${availableSpecialists.length})`,
  );

  // Build list of colleague names for conversational references
  const colleagueNames = availableSpecialists
    .filter((s) => s.name !== agent.name)
    .map((s) => `${s.name} (${s.role})`)
    .join(', ');

  const systemPrompt = `You are ${agent.name}, a ${agent.role}.

${agent.instructions || ''}

Your expertise: ${agent.expertise || agent.responsibilities || 'Specialist'}

IMPORTANT: Structure your response in THREE clear sections:

<THINKING>
Your internal reasoning process. Brief notes on your approach and key considerations.
</THINKING>

<COLLABORATION_CONVO>
**${agent.name}${agent.credentials ? `, ${agent.credentials}` : ''} — ${agent.role}**

[Your dialogue here - NO quote marks, conversational, 100-200 words MAX]
</COLLABORATION_CONVO>

**COLLABORATION_CONVO RULES (100-200 words MAXIMUM):**
- Start with **[Name, Credentials] — [Title]** header
- NO quote marks around dialogue - write naturally
- ${previousContributions.length > 0 ? `Address colleagues by name (e.g., "${availableSpecialists[0]?.name || 'Marcus'}, I need to flag something...")` : 'Introduce your findings to the team'}
- One focused exchange - like a real meeting comment, not a monologue
- 1-2 specific data points only

## EXAMPLE (follow this format exactly):
<COLLABORATION_CONVO>
**Thomas Blackwood, PE — Engineering Technical Lead**

Patricia, hold on—what species are we dealing with? That's going to affect our route flexibility options. If it's desert tortoise or sage grouse, we've got established mitigation playbooks. Something more constrained could change the engineering calculus significantly.
</COLLABORATION_CONVO>

<OUTPUT>
Your final expert analysis in bullet points. Be specific with data, percentages, and timeframes.
</OUTPUT>

${colleagueNames ? `Your colleagues on this project: ${colleagueNames}` : ''}

## CRITICAL REQUIREMENTS:
- **COLLABORATION_CONVO: 100-200 words MAX** - concise like a meeting exchange
- THINKING: Brief internal reasoning
- OUTPUT: Structured analysis with specific data points
- Be conversational but professional
${collaborationGuidelines}${toolInstructions}`;

  const client = new Anthropic({ apiKey });

  // Build the user message with all available context
  const hasContext = previousContributions.length > 0 || conversationContext || additionalContext;
  const userContent = hasContext
    ? `# Objective\n${userMessage}\n\n# Your Assignment\n${assignment || 'Provide your specialist analysis.'}\n\n${additionalContext}${conversationContext}${collaborationContext}`
    : `Objective: ${userMessage}\n\nYour Assignment: ${assignment || 'Provide your specialist analysis.'}`;

  // Prepare messages array for potential continuation after tool use
  let messages = [{ role: 'user', content: userContent }];

  // Build tools array - always include ask_user, add colleague tool if colleagues available
  const tools = [ASK_USER_TOOL];
  if (availableSpecialists.length > 1) {
    tools.push(REQUEST_FROM_COLLEAGUE_TOOL);
  }

  logger.info(
    `[executeSpecialist] Tools for ${agent.name}: ${tools.length} tools (ask_user=YES, colleagues=${availableSpecialists.length > 1 ? 'YES' : 'NO'})`,
  );
  logger.debug(`[executeSpecialist] Tool names: ${tools.map((t) => t.name).join(', ')}`);

  /**
   * Inner function to execute the streaming request and handle responses
   * Returns { text, toolUse } where toolUse is set if the model wants to use a tool
   */
  const executeStreamingRequest = async (msgs) => {
    let accumulatedText = '';
    let thinkingText = '';
    let lastThinkingSent = '';
    let chunkCount = 0;
    let toolUseBlock = null;
    let currentToolInput = '';

    const streamOptions = {
      model: agent.model || ORCHESTRATOR_ANTHROPIC_MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: msgs,
    };

    if (tools) {
      streamOptions.tools = tools;
    }

    logger.info(
      `[executeSpecialist] Stream options for ${agent.name}: model=${streamOptions.model}, max_tokens=${streamOptions.max_tokens}, tools=${streamOptions.tools ? 'YES' : 'NO'}`,
    );
    logger.debug(
      `[executeSpecialist] System prompt includes tool instructions: ${systemPrompt.includes('request_from_colleague')}`,
    );

    const stream = client.messages.stream(streamOptions);

    logger.info(`[executeSpecialist] Starting stream for ${agent.name}`);

    let lastCollabSent = '';
    let collabText = '';

    // Stream each chunk and extract thinking/collaboration in real-time
    for await (const event of stream) {
      // Handle text content
      if (event.type === 'content_block_delta' && event.delta?.text) {
        const chunk = event.delta.text;
        accumulatedText += chunk;
        chunkCount++;

        // Try to extract COLLABORATION_CONVO section as it streams (primary - shown to user)
        const collabMatch = accumulatedText.match(
          /<COLLABORATION_CONVO>([\s\S]*?)(?:<\/COLLABORATION_CONVO>|$)/i,
        );
        if (collabMatch && collabMatch[1]) {
          const currentCollab = collabMatch[1].trim();

          // Send updates when collaboration content grows significantly
          if (currentCollab.length > lastCollabSent.length + 30 || chunkCount % 3 === 0) {
            collabText = currentCollab;
            lastCollabSent = currentCollab;

            if (onThinking) {
              onThinking({
                agent: agent.name,
                role: agent.role,
                action: 'collaboration',
                message:
                  currentCollab.substring(0, 150) + (currentCollab.length > 150 ? '...' : ''),
                collaboration: currentCollab,
              });
            }
          }
        }

        // Also extract THINKING section (secondary)
        const thinkingMatch = accumulatedText.match(/<THINKING>([\s\S]*?)(?:<\/THINKING>|$)/i);
        if (thinkingMatch && thinkingMatch[1]) {
          const currentThinking = thinkingMatch[1].trim();

          // Send updates every few chunks or when thinking content grows significantly
          if (currentThinking.length > lastThinkingSent.length + 50 || chunkCount % 5 === 0) {
            thinkingText = currentThinking;
            lastThinkingSent = currentThinking;

            if (onThinking) {
              onThinking({
                agent: agent.name,
                role: agent.role,
                action: 'thinking',
                message:
                  currentThinking.substring(0, 100) + (currentThinking.length > 100 ? '...' : ''),
                thinking: currentThinking,
              });
            }
          }
        }
      }

      // Handle tool use content block start
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        toolUseBlock = {
          id: event.content_block.id,
          name: event.content_block.name,
          input: {},
        };
        currentToolInput = '';
        logger.info(
          `[executeSpecialist] ${agent.name} starting tool use: ${event.content_block.name}`,
        );
      }

      // Handle tool use input delta
      if (event.type === 'content_block_delta' && event.delta?.partial_json) {
        currentToolInput += event.delta.partial_json;
      }

      // Handle tool use content block stop
      if (event.type === 'content_block_stop' && toolUseBlock) {
        try {
          toolUseBlock.input = JSON.parse(currentToolInput);
          logger.info(
            `[executeSpecialist] ${agent.name} tool input parsed: ${JSON.stringify(toolUseBlock.input)}`,
          );
        } catch (e) {
          logger.warn(`[executeSpecialist] Failed to parse tool input: ${currentToolInput}`);
          toolUseBlock.input = { error: 'Failed to parse input' };
        }
      }

      // Log message delta events to see stop reason
      if (event.type === 'message_delta') {
        logger.info(
          `[executeSpecialist] ${agent.name} message_delta: stop_reason=${event.delta?.stop_reason}`,
        );
      }
    }

    logger.info(
      `[executeSpecialist] ${agent.name} stream complete. Total: ${accumulatedText.length} chars, ${chunkCount} chunks, toolUse: ${toolUseBlock ? 'yes' : 'no'}`,
    );

    return {
      text: accumulatedText,
      toolUse: toolUseBlock,
      thinkingText,
      lastThinkingSent,
      collabText,
      lastCollabSent,
    };
  };

  // Execute initial request
  let result = await executeStreamingRequest(messages);
  let accumulatedText = result.text;
  let thinkingText = result.thinkingText;
  let lastThinkingSent = result.lastThinkingSent;
  let collabText = result.collabText || '';
  let lastCollabSent = result.lastCollabSent || '';

  // Handle tool use if the model requested it
  if (result.toolUse) {
    const toolInput = result.toolUse.input;
    let toolResult;

    if (result.toolUse.name === 'ask_user_in_conversation') {
      // Handle user question tool
      logger.info(
        `[executeSpecialist] ${agent.name} asking user (${toolInput.importance}): ${toolInput.question}`,
      );

      if (onThinking) {
        onThinking({
          agent: agent.name,
          role: agent.role,
          action: 'asking_user',
          importance: toolInput.importance,
          message: `Question for user: ${toolInput.question}`,
          question: toolInput.question,
          options: toolInput.options,
        });
      }

      // Ensure options is an array (model might send it as string or other format)
      const optionsArray = Array.isArray(toolInput.options) ? toolInput.options : [];
      const optionsText =
        optionsArray.length > 0
          ? `\n\nOptions:\n${optionsArray.map((o, i) => `${i + 1}. ${o}`).join('\n')}`
          : '';

      if (toolInput.importance === 'critical' || toolInput.importance === 'important') {
        // For CRITICAL or IMPORTANT questions, STOP execution and return pending question
        logger.info(
          `[executeSpecialist] ${agent.name} has ${toolInput.importance.toUpperCase()} question - halting for user input`,
        );

        // Return early with pending question - don't continue the conversation
        return {
          response: accumulatedText || '',
          pendingQuestion: {
            agent: agent.name,
            agentRole: agent.role,
            question: toolInput.question,
            options: optionsArray,
            importance: toolInput.importance,
            context: toolInput.context,
          },
        };
      } else {
        // For "helpful" questions only, proceed with assumptions
        toolResult = `Your question has been noted: "${toolInput.question}"${optionsText}

Since this is marked as "helpful" (not critical/important), please proceed with your analysis using reasonable assumptions. Clearly state your assumptions in the output so the user can validate or correct them.`;
      }
    } else if (result.toolUse.name === 'request_from_colleague') {
      // Handle colleague request tool
      logger.info(
        `[executeSpecialist] ${agent.name} requesting info from colleague: ${toolInput.colleague_role}`,
      );

      // Find the matching colleague first so we can use their name
      const colleague = findColleague(toolInput.colleague_role, availableSpecialists, agent);
      const colleagueName = colleague ? colleague.name : toolInput.colleague_role;

      // Build the formatted dialogue using the required format:
      // **[Full Name, Credentials] — [Title]**
      // "[Dialogue content]"
      const agentHeader = `**${agent.name}${agent.credentials ? `, ${agent.credentials}` : ''} — ${agent.role}**`;
      const dialogueContent = toolInput.context
        ? `"${colleagueName}, ${toolInput.question}"\n\n_Context: ${toolInput.context}_`
        : `"${colleagueName}, ${toolInput.question}"`;
      const questionText = `${agentHeader}\n\n${dialogueContent}`;

      if (onThinking) {
        // First show the question being asked (as collaboration from requesting agent)
        onThinking({
          agent: agent.name,
          role: agent.role,
          action: 'collaboration',
          message: `Asking ${colleagueName}: ${toolInput.question.substring(0, 100)}...`,
          collaboration: questionText,
        });
      }

      if (colleague) {
        // Execute the colleague query (this will stream the response)
        const colleagueResponse = await executeColleagueQuery({
          colleague,
          question: toolInput.question,
          context: toolInput.context,
          requestingAgent: agent,
          userMessage,
          apiKey,
          onThinking,
        });
        toolResult = `**Response from ${colleague.name} (${colleague.role}):**\n\n${colleagueResponse}`;
      } else {
        logger.warn(
          `[executeSpecialist] Could not find colleague matching: ${toolInput.colleague_role}`,
        );
        toolResult = `Could not find a colleague matching "${toolInput.colleague_role}". Available team members are: ${availableSpecialists.map((s) => s.role).join(', ')}. Please proceed with your analysis using available information.`;
      }
    } else {
      // Unknown tool
      logger.warn(`[executeSpecialist] Unknown tool called: ${result.toolUse.name}`);
      toolResult = `Unknown tool: ${result.toolUse.name}. Please proceed with your analysis.`;
    }

    // Continue the conversation with the tool result
    logger.debug(
      `[executeSpecialist] Building continuation messages. accumulatedText length: ${accumulatedText.length}, toolUse.id: ${result.toolUse.id}`,
    );

    const assistantContent = [
      ...(accumulatedText ? [{ type: 'text', text: accumulatedText }] : []),
      {
        type: 'tool_use',
        id: result.toolUse.id,
        name: result.toolUse.name,
        input: result.toolUse.input,
      },
    ];

    messages.push({
      role: 'assistant',
      content: assistantContent,
    });

    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: result.toolUse.id,
          content: toolResult,
        },
      ],
    });

    logger.debug(`[executeSpecialist] Tool result content: ${toolResult.substring(0, 100)}...`);

    // Determine continuation message based on tool type
    const continuationMessage =
      result.toolUse.name === 'ask_user_in_conversation'
        ? `Proceeding with analysis (user question noted)...`
        : `Received colleague input, continuing analysis...`;

    if (onThinking) {
      onThinking({
        agent: agent.name,
        role: agent.role,
        action: 'continuing',
        message: continuationMessage,
      });
    }

    logger.info(
      `[executeSpecialist] ${agent.name} continuing after tool use: ${result.toolUse.name}`,
    );
    logger.debug(
      `[executeSpecialist] Messages for continuation: ${messages.length} messages, last message role: ${messages[messages.length - 1]?.role}`,
    );

    // Execute continuation request
    try {
      const continuationResult = await executeStreamingRequest(messages);
      accumulatedText += '\n\n' + continuationResult.text;
      if (continuationResult.thinkingText) {
        thinkingText = continuationResult.thinkingText;
      }
      if (continuationResult.lastThinkingSent) {
        lastThinkingSent = continuationResult.lastThinkingSent;
      }
      if (continuationResult.collabText) {
        collabText = continuationResult.collabText;
      }
      if (continuationResult.lastCollabSent) {
        lastCollabSent = continuationResult.lastCollabSent;
      }

      logger.info(
        `[executeSpecialist] ${agent.name} continuation complete, accumulated ${accumulatedText.length} chars`,
      );
    } catch (continuationError) {
      logger.error(
        `[executeSpecialist] ${agent.name} continuation FAILED: ${continuationError.message}`,
      );
      logger.error(`[executeSpecialist] Continuation error stack: ${continuationError.stack}`);
      // Don't throw - allow the function to complete with what we have
    }
  }

  // Final extraction
  const finalThinkingMatch = accumulatedText.match(/<THINKING>([\s\S]*?)<\/THINKING>/i);
  const finalCollabMatch = accumulatedText.match(
    /<COLLABORATION_CONVO>([\s\S]*?)<\/COLLABORATION_CONVO>/i,
  );
  const finalOutputMatch = accumulatedText.match(/<OUTPUT>([\s\S]*?)<\/OUTPUT>/i);

  let outputText = '';
  if (finalThinkingMatch) {
    thinkingText = finalThinkingMatch[1].trim();
  }
  if (finalCollabMatch) {
    collabText = finalCollabMatch[1].trim();
  }
  if (finalOutputMatch) {
    outputText = finalOutputMatch[1].trim();
  }

  logger.info(
    `[executeSpecialist] ${agent.name} has THINKING: ${!!finalThinkingMatch}, COLLABORATION_CONVO: ${!!finalCollabMatch}, OUTPUT: ${!!finalOutputMatch}`,
  );

  // Send final collaboration update if we have it and it wasn't fully sent
  if (onThinking && collabText && collabText !== lastCollabSent) {
    onThinking({
      agent: agent.name,
      role: agent.role,
      action: 'collaboration',
      message: collabText.substring(0, 150) + (collabText.length > 150 ? '...' : ''),
      collaboration: collabText,
    });
  }

  // If no tags found, try to use the whole response as output
  if (!outputText && !thinkingText && !collabText) {
    logger.warn(
      `[executeSpecialist] No THINKING/COLLABORATION_CONVO/OUTPUT tags found for ${agent.name}, using raw response`,
    );
    outputText = accumulatedText;
  } else if (!outputText) {
    // If we have thinking but no output, the output might come after thinking without tags
    const afterThinking = accumulatedText.replace(/<THINKING>[\s\S]*?<\/THINKING>/gi, '').trim();
    if (afterThinking) {
      outputText = afterThinking;
    }
  }

  logger.info(
    `[executeSpecialist] ${agent.name} final: thinking=${thinkingText.length} chars, output=${outputText.length} chars`,
  );

  // Send final thinking update if not already sent
  if (onThinking && thinkingText && thinkingText !== lastThinkingSent) {
    logger.debug(
      `[executeSpecialist] Sending final thinking for ${agent.name}: ${thinkingText.length} chars`,
    );
    onThinking({
      agent: agent.name,
      role: agent.role,
      action: 'thinking',
      message: thinkingText.substring(0, 100) + (thinkingText.length > 100 ? '...' : ''),
      thinking: thinkingText,
    });
  }

  if (onThinking) {
    onThinking({
      agent: agent.name,
      role: agent.role,
      action: 'completed',
      message: `Completed analysis`,
    });
  }

  logger.info(
    `[executeSpecialist] ${agent.name} completed - thinking: ${thinkingText.length} chars, output: ${outputText.length} chars`,
  );

  // Return response object (consistent format with pendingQuestion case)
  return {
    response: outputText || accumulatedText,
    pendingQuestion: null,
  };
};

const isArtifactComplete = (text) => {
  const artifactStart = text.indexOf(':::artifact');
  if (artifactStart === -1) return false;

  const afterStart = text.substring(artifactStart + 11);
  const closingTagIndex = afterStart.indexOf(':::');
  return closingTagIndex !== -1;
};

const getContinuationContext = (text, maxContextLength = 1500) => {
  const artifactStart = text.indexOf(':::artifact');
  if (artifactStart === -1) {
    const lines = text.split('\n');
    const lastLines = lines.slice(-30).join('\n');
    return lastLines.length > maxContextLength
      ? lastLines.substring(lastLines.length - maxContextLength)
      : lastLines;
  }

  const markdownStart = text.indexOf('```markdown', artifactStart);
  if (markdownStart === -1) {
    const headerEnd = text.indexOf('\n', artifactStart + 11);
    if (headerEnd === -1) return '';
    const artifactContent = text.substring(headerEnd + 1);
    const lines = artifactContent.split('\n');
    const lastLines = lines.slice(-30).join('\n');
    return lastLines.length > maxContextLength
      ? lastLines.substring(lastLines.length - maxContextLength)
      : lastLines;
  }

  const contentStart = markdownStart + 11;
  const markdownEnd = text.indexOf('```', contentStart);
  const artifactEnd = text.indexOf(':::', markdownEnd !== -1 ? markdownEnd : contentStart);

  const endPos = markdownEnd !== -1 && markdownEnd < artifactEnd ? markdownEnd : artifactEnd;
  if (endPos === -1) {
    const artifactContent = text.substring(contentStart);
    const lines = artifactContent.split('\n');
    const lastLines = lines.slice(-30).join('\n');
    return lastLines.length > maxContextLength
      ? lastLines.substring(lastLines.length - maxContextLength)
      : lastLines;
  }

  const artifactContent = text.substring(contentStart, endPos);
  const lines = artifactContent.split('\n');
  const lastLines = lines.slice(-30).join('\n');

  return lastLines.length > maxContextLength
    ? lastLines.substring(lastLines.length - maxContextLength)
    : lastLines;
};

const synthesizeDeliverableStreaming = async ({
  lead,
  userMessage,
  specialistInputs,
  deliverableOutline,
  apiKey,
  onThinking,
  onStream,
}) => {
  const inputsSummary = specialistInputs
    .map((s) => `### ${s.name} (${s.role})\n${s.response}`)
    .join('\n\n---\n\n');

  if (onThinking) {
    onThinking({
      agent: lead.name,
      action: 'synthesizing',
      message: `Synthesizing team inputs into final deliverable...`,
    });
  }

  const systemPrompt = `You are ${lead.name}, ${lead.role}.

Synthesize the specialist inputs into ONE cohesive, professional deliverable.

Create a UNIFIED document that:
1. Has a clear executive summary
2. Integrates all insights seamlessly
3. Provides actionable recommendations
4. Is written as ONE coherent narrative
5. Uses proper Markdown formatting

Do NOT just combine responses. Write as if one expert authored the entire document.

${energySectorContext}

IMPORTANT OUTPUT FORMAT:
Your response MUST include:
1. A brief introductory description (2-4 sentences) explaining what has been prepared and what the document contains. This description should appear BEFORE the artifact.
2. The document itself wrapped in the artifact tag format below.

The contents of the document should be wrapped around the following tag in order to display it as an artifact:

:::artifact{identifier="unique-document-identifier" type="text/markdown" title="Document Title.md"}
\`\`\`markdown
Document contents in markdown
\`\`\`
:::

Only wrap it in the format specified, do not include additional code-tags or other syntax.
When modifying a deliverable/document make sure the identifier stays the same - it is used to track the document in the system.

If there is no deliverable ready - for example, more information from the user was requested in order to produce it, do not produce an artifact.`;

  const client = new Anthropic({ apiKey });
  let fullText = '';
  let finishReason = null;
  let attempts = 0;
  const maxAttempts = 15;

  while (attempts < maxAttempts) {
    const isContinuation = attempts > 0;
    let messages = [];

    if (isContinuation) {
      const artifactStart = fullText.indexOf(':::artifact');
      const hasArtifactStarted = artifactStart !== -1;

      let continuationText = fullText;
      if (hasArtifactStarted) {
        const context = getContinuationContext(fullText, 3000);
        const introText = artifactStart > 0 ? fullText.substring(0, artifactStart) : '';
        const artifactHeader = fullText.substring(
          artifactStart,
          fullText.indexOf('\n', artifactStart) + 1,
        );
        const markdownStart = fullText.indexOf('```markdown', artifactStart);
        const afterMarkdown =
          markdownStart !== -1
            ? fullText.substring(markdownStart + 12, markdownStart + 12 + 100)
            : '';
        continuationText =
          introText +
          artifactHeader +
          (markdownStart !== -1 ? '```markdown\n' : '') +
          (context || fullText.substring(Math.max(0, fullText.length - 3000)));
      }

      messages.push({
        role: 'assistant',
        content: continuationText,
      });

      const continuationInstruction = hasArtifactStarted
        ? 'CRITICAL: The artifact has ALREADY STARTED. Do NOT repeat the :::artifact tag or the ```markdown tag. Continue ONLY the document content from where it was cut off. Simply continue writing the markdown content. When finished, close with ``` and ::: tags.'
        : 'Continue generating from where you left off. Complete the document and make sure to properly close the artifact tag with ::: at the end.';

      messages.push({
        role: 'user',
        content: continuationInstruction,
      });

      if (onThinking) {
        onThinking({
          agent: lead.name,
          action: 'continuing',
          message: `Continuing deliverable generation...`,
        });
      }
    } else {
      messages.push({
        role: 'user',
        content: `# Objective\n${userMessage}\n\n# Deliverable Structure\n${deliverableOutline || 'Professional analysis document'}\n\n# Specialist Inputs\n\n${inputsSummary}\n\n---\n\nSynthesize into ONE unified deliverable document in Markdown format.`,
      });
    }

    const stream = client.messages.stream({
      model: ORCHESTRATOR_ANTHROPIC_MODEL,
      max_tokens: 4000,
      system: systemPrompt,
      messages: messages,
    });

    let currentChunk = '';
    let lastEvent = null;
    let isFirstChunk = true;
    let artifactHeaderSkipped = false;

    for await (const event of stream) {
      lastEvent = event;

      if (event.type === 'content_block_delta' && event.delta?.text) {
        let chunk = event.delta.text;

        if (isContinuation && isFirstChunk && !artifactHeaderSkipped) {
          const artifactStartPattern = /^[\s\n]*:::artifact[^\n]*\n?/;
          const markdownStartPattern = /^[\s\n]*```markdown[\s\n]*/;

          if (artifactStartPattern.test(chunk)) {
            chunk = chunk.replace(artifactStartPattern, '');
            artifactHeaderSkipped = true;
            logger.info(
              '[synthesizeDeliverableStreaming] Removed duplicate artifact header from continuation',
            );
          }

          if (markdownStartPattern.test(chunk) && fullText.includes('```markdown')) {
            chunk = chunk.replace(markdownStartPattern, '');
            artifactHeaderSkipped = true;
            logger.info(
              '[synthesizeDeliverableStreaming] Removed duplicate markdown tag from continuation',
            );
          }

          isFirstChunk = false;
        }

        if (chunk) {
          currentChunk += chunk;
          fullText += chunk;
          if (onStream) {
            onStream(chunk);
          }
        }
      }

      if (event.type === 'message_stop' || event.type === 'message_delta') {
        finishReason = event.finish_reason || event.delta?.stop_reason;
      }
    }

    const isComplete = isArtifactComplete(fullText);
    const needsContinuation =
      finishReason === 'max_tokens' || (!isComplete && currentChunk.length > 0);

    if (isComplete || !needsContinuation || attempts >= maxAttempts - 1) {
      logger.info(
        `[synthesizeDeliverableStreaming] Artifact complete or no continuation needed, breaking (attempt ${attempts})`,
      );
      break;
    }

    attempts++;
    logger.info(
      `[synthesizeDeliverableStreaming] Artifact incomplete, continuing (attempt ${attempts})`,
    );
  }

  if (!isArtifactComplete(fullText) && fullText.includes(':::artifact')) {
    logger.warn('[synthesizeDeliverableStreaming] Artifact incomplete, adding closing tag');
    const closingTag = '\n:::\n';
    fullText += closingTag;
    if (onStream) {
      onStream(closingTag);
    }
  }

  if (onThinking) {
    onThinking({
      agent: lead.name,
      action: 'complete',
      message: `Deliverable ready`,
    });
  }

  return fullText;
};

/**
 * Resume orchestration after user answered a critical question
 */
const resumeOrchestration = async ({
  pendingState,
  userMessage, // User's answer to the question
  teamAgents,
  conversationHistory,
  fileContext,
  knowledgeContext,
  config,
  conversationId,
  onAgentStart,
  onAgentComplete,
  onThinking,
  onStream,
}) => {
  const apiKey = config?.endpoints?.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY;

  const {
    workPlan,
    specialistInputs,
    responses,
    selectedSpecialists,
    stoppedAtSpecialistIndex,
    pendingQuestion,
    lead,
    originalUserMessage,
  } = pendingState;

  logger.info(
    `[resumeOrchestration] Resuming with user answer: "${userMessage.substring(0, 100)}..."`,
  );
  logger.info(
    `[resumeOrchestration] Resuming from specialist ${stoppedAtSpecialistIndex}, ${specialistInputs.length} inputs accumulated`,
  );

  // Clear the pending state since we're resuming
  clearOrchestrationState(conversationId);

  // Find the specialist agent objects from teamAgents
  const specialists = teamAgents.filter((a) => parseInt(a.tier) !== 3 && parseInt(a.tier) !== 5);
  const fullSelectedSpecialists = selectedSpecialists.map((saved) => {
    const found = specialists.find((s) => s.name === saved.name);
    return found || saved; // Fallback to saved if not found
  });

  // Get the full lead agent
  const fullLead = teamAgents.find((a) => a.name === lead.name) || lead;

  // Resume from where we stopped
  let currentSpecialistInputs = [...specialistInputs];
  let currentResponses = [...responses];
  let pendingUserQuestion = null;
  let newStoppedAtIndex = -1;

  // The specialist that asked the question needs to continue with the user's answer
  const stoppedSpecialist = fullSelectedSpecialists[stoppedAtSpecialistIndex];

  if (stoppedSpecialist) {
    if (onAgentStart) onAgentStart(stoppedSpecialist);

    if (onThinking) {
      onThinking({
        agent: stoppedSpecialist.name,
        role: stoppedSpecialist.role,
        action: 'continuing',
        message: `Received user response, continuing analysis...`,
      });
    }

    // Re-run the stopped specialist with the user's answer as additional context
    const idx = specialists.indexOf(stoppedSpecialist) + 1;
    const assignment = workPlan.assignments?.[idx.toString()] || workPlan.assignments?.[idx] || '';

    // Build context that includes the original question and user's answer
    const resumeContext = `
## User Response to Your Question
You previously asked: "${pendingQuestion.question}"

User's response: "${userMessage}"

Please continue your analysis incorporating this information.
`;

    const specialistResult = await executeSpecialist({
      agent: stoppedSpecialist,
      assignment: assignment + resumeContext,
      userMessage: originalUserMessage,
      apiKey,
      onThinking,
      previousContributions: currentSpecialistInputs.filter((i) => !i.hasPendingQuestion),
      conversationHistory,
      fileContext,
      knowledgeContext,
      availableSpecialists: fullSelectedSpecialists,
    });

    // Check if this specialist has another pending question
    if (specialistResult.pendingQuestion) {
      logger.info(`[resumeOrchestration] ${stoppedSpecialist.name} has another pending question`);
      pendingUserQuestion = specialistResult.pendingQuestion;
      newStoppedAtIndex = stoppedAtSpecialistIndex;
    } else {
      // Replace the partial input with the complete one
      const existingIndex = currentSpecialistInputs.findIndex(
        (i) => i.name === stoppedSpecialist.name,
      );
      if (existingIndex >= 0) {
        currentSpecialistInputs[existingIndex] = {
          name: stoppedSpecialist.name,
          role: stoppedSpecialist.role,
          response: specialistResult.response,
        };
      } else {
        currentSpecialistInputs.push({
          name: stoppedSpecialist.name,
          role: stoppedSpecialist.role,
          response: specialistResult.response,
        });
      }

      currentResponses.push({
        agentId: stoppedSpecialist.agentId,
        agentName: stoppedSpecialist.name,
        agentRole: stoppedSpecialist.role,
        response: specialistResult.response,
      });

      if (onAgentComplete)
        onAgentComplete({
          agentName: stoppedSpecialist.name,
          agentRole: stoppedSpecialist.role,
          response: specialistResult.response,
        });
    }
  }

  // Continue with remaining specialists (if no new pending question)
  if (!pendingUserQuestion) {
    for (let i = stoppedAtSpecialistIndex + 1; i < fullSelectedSpecialists.length; i++) {
      const specialist = fullSelectedSpecialists[i];
      if (onAgentStart) onAgentStart(specialist);

      const idx = specialists.indexOf(specialist) + 1;
      const assignment =
        workPlan.assignments?.[idx.toString()] || workPlan.assignments?.[idx] || '';

      const specialistResult = await executeSpecialist({
        agent: specialist,
        assignment,
        userMessage: originalUserMessage,
        apiKey,
        onThinking,
        previousContributions: [...currentSpecialistInputs],
        conversationHistory,
        fileContext,
        knowledgeContext,
        availableSpecialists: fullSelectedSpecialists,
      });

      if (specialistResult.pendingQuestion) {
        logger.info(
          `[resumeOrchestration] ${specialist.name} has pending question - stopping again`,
        );
        pendingUserQuestion = specialistResult.pendingQuestion;
        newStoppedAtIndex = i;

        if (specialistResult.response) {
          currentSpecialistInputs.push({
            name: specialist.name,
            role: specialist.role,
            response: specialistResult.response,
            hasPendingQuestion: true,
          });
        }
        break;
      }

      currentSpecialistInputs.push({
        name: specialist.name,
        role: specialist.role,
        response: specialistResult.response,
      });

      currentResponses.push({
        agentId: specialist.agentId,
        agentName: specialist.name,
        agentRole: specialist.role,
        response: specialistResult.response,
      });

      if (onAgentComplete)
        onAgentComplete({
          agentName: specialist.name,
          agentRole: specialist.role,
          response: specialistResult.response,
        });

      logger.info(
        `[resumeOrchestration] Specialist ${i + 1}/${fullSelectedSpecialists.length} (${specialist.name}) completed.`,
      );
    }
  }

  // If there's another pending question, save state and return
  if (pendingUserQuestion) {
    if (conversationId) {
      const stateToSave = {
        workPlan,
        specialistInputs: currentSpecialistInputs,
        responses: currentResponses,
        selectedSpecialists,
        stoppedAtSpecialistIndex: newStoppedAtIndex,
        pendingQuestion: pendingUserQuestion,
        lead,
        originalUserMessage,
      };
      saveOrchestrationState(conversationId, stateToSave);
    }

    const optionsArray = Array.isArray(pendingUserQuestion.options)
      ? pendingUserQuestion.options
      : [];
    const optionsText =
      optionsArray.length > 0
        ? '\n\n**Options:**\n' + optionsArray.map((o, i) => `${i + 1}. ${o}`).join('\n')
        : '';

    const questionMessage = `**${pendingUserQuestion.agent}** (${pendingUserQuestion.agentRole}) needs additional clarification:

---

${pendingUserQuestion.question}${optionsText}

---

_Please respond to continue the analysis._`;

    // Stream the question incrementally
    if (onStream) {
      await streamTextIncrementally(questionMessage, onStream);
    }

    return {
      success: true,
      waitingForInput: true,
      pendingQuestion: pendingUserQuestion,
      responses: currentResponses,
      formattedResponse: questionMessage,
      selectedAgents: [fullLead, ...fullSelectedSpecialists.slice(0, newStoppedAtIndex + 1)].map(
        (a) => ({
          id: a.agentId,
          name: a.name,
          role: a.role,
        }),
      ),
    };
  }

  // All specialists complete - synthesize
  if (onAgentStart) onAgentStart({ ...fullLead, phase: 'synthesis' });

  const finalDeliverable = await synthesizeDeliverableStreaming({
    lead: fullLead,
    userMessage: originalUserMessage,
    specialistInputs: currentSpecialistInputs,
    deliverableOutline: workPlan.deliverableOutline,
    apiKey,
    onThinking,
    onStream,
  });

  const timestamp = new Date().toISOString().split('T')[0];
  const teamCredits = `\n\n---\n\n_**Team:** ${fullLead.name} (Lead)${fullSelectedSpecialists.length > 0 ? ', ' + fullSelectedSpecialists.map((s) => s.name).join(', ') : ''} | ${timestamp}_`;

  const formattedResponse = finalDeliverable + teamCredits;

  if (onStream) {
    onStream(teamCredits);
  }

  logger.info(
    `[resumeOrchestration] Completed with ${fullSelectedSpecialists.length + 1} contributors`,
  );

  return {
    success: true,
    waitingForInput: false,
    responses: currentResponses,
    formattedResponse,
    selectedAgents: [fullLead, ...fullSelectedSpecialists].map((a) => ({
      id: a.agentId,
      name: a.name,
      role: a.role,
    })),
    workPlan,
  };
};

/**
 * Main orchestration function with visible collaboration
 * Supports resumption after user answers a critical question
 */
const orchestrateTeamResponse = async ({
  userMessage,
  teamAgents,
  conversationHistory,
  fileContext,
  knowledgeContext,
  config,
  conversationId,
  onAgentStart,
  onAgentComplete,
  onThinking,
  onStream,
}) => {
  try {
    logger.info(
      `[orchestrateTeamResponse] Starting with ${teamAgents.length} agents, conversationId: ${conversationId}`,
    );

    const apiKey = config?.endpoints?.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('Anthropic API key not configured');
    }

    const lead = teamAgents.find((a) => parseInt(a.tier) === 3) || teamAgents[0];
    const specialists = teamAgents.filter((a) => parseInt(a.tier) !== 3 && parseInt(a.tier) !== 5);

    // Check for pending orchestration state (resuming after user answered a question)
    const pendingState = conversationId ? getOrchestrationState(conversationId) : null;

    if (pendingState) {
      logger.info(
        `[orchestrateTeamResponse] Found pending state - resuming from specialist ${pendingState.stoppedAtSpecialistIndex + 1}`,
      );

      // Resume orchestration with the user's answer
      return await resumeOrchestration({
        pendingState,
        userMessage, // This is the user's answer to the critical question
        teamAgents,
        conversationHistory,
        fileContext,
        knowledgeContext,
        config,
        conversationId,
        onAgentStart,
        onAgentComplete,
        onThinking,
        onStream,
      });
    }

    const responses = [];

    // PHASE 1: Lead Analysis (with all context)
    if (onAgentStart) onAgentStart(lead);

    logger.info(
      `[orchestrateTeamResponse] Passing context to agents - conversation: ${conversationHistory?.length || 0} messages, fileContext: ${fileContext ? 'yes' : 'no'}, knowledgeContext: ${knowledgeContext ? 'yes' : 'no'}`,
    );

    const workPlan = await executeLeadAnalysis({
      lead,
      userMessage,
      apiKey,
      teamAgents,
      onThinking,
      conversationHistory,
      fileContext,
      knowledgeContext,
    });

    if (onAgentComplete)
      onAgentComplete({
        agentName: lead.name,
        agentRole: lead.role,
        response: workPlan.analysis,
      });

    // PHASE 2: Execute Selected Specialists
    const selectedIndices = workPlan.selectedSpecialists || [];
    const selectedSpecialists = selectedIndices.map((idx) => specialists[idx - 1]).filter(Boolean);

    logger.info(`[orchestrateTeamResponse] Selected ${selectedSpecialists.length} specialists`);

    const specialistInputs = [];
    let pendingUserQuestion = null;
    let stoppedAtSpecialistIndex = -1;

    // Execute specialists in a collaborative chain - each sees previous contributions
    for (let i = 0; i < selectedSpecialists.length; i++) {
      const specialist = selectedSpecialists[i];
      if (onAgentStart) onAgentStart(specialist);

      const idx = specialists.indexOf(specialist) + 1;
      const assignment =
        workPlan.assignments?.[idx.toString()] || workPlan.assignments?.[idx] || '';

      // Pass previous contributions, all context, and available specialists for collaboration
      const specialistResult = await executeSpecialist({
        agent: specialist,
        assignment,
        userMessage,
        apiKey,
        onThinking,
        previousContributions: [...specialistInputs], // Clone to avoid mutation issues
        conversationHistory,
        fileContext,
        knowledgeContext,
        availableSpecialists: selectedSpecialists, // Enable tool-based colleague queries
      });

      // Check if specialist has a pending critical question
      if (specialistResult.pendingQuestion) {
        logger.info(
          `[orchestrateTeamResponse] ${specialist.name} has pending CRITICAL question - stopping orchestration`,
        );
        pendingUserQuestion = specialistResult.pendingQuestion;
        stoppedAtSpecialistIndex = i;

        // Add partial response to inputs if any
        if (specialistResult.response) {
          specialistInputs.push({
            name: specialist.name,
            role: specialist.role,
            response: specialistResult.response,
            hasPendingQuestion: true,
          });
        }

        break; // Stop the specialist loop
      }

      specialistInputs.push({
        name: specialist.name,
        role: specialist.role,
        response: specialistResult.response,
      });

      responses.push({
        agentId: specialist.agentId,
        agentName: specialist.name,
        agentRole: specialist.role,
        response: specialistResult.response,
      });

      if (onAgentComplete)
        onAgentComplete({
          agentName: specialist.name,
          agentRole: specialist.role,
          response: specialistResult.response,
        });

      logger.info(
        `[orchestrateTeamResponse] Specialist ${i + 1}/${selectedSpecialists.length} (${specialist.name}) completed. Chain progress: ${specialistInputs.length} contributions accumulated.`,
      );

      // Executive Status Update every 2-3 specialist completions
      // Provides status updates as required by the collaboration protocol
      const shouldProvideStatusUpdate = (i + 1) % 3 === 0 && i + 1 < selectedSpecialists.length;
      if (shouldProvideStatusUpdate && onThinking) {
        const completedNames = specialistInputs.map((s) => s.name).join(', ');
        const nextSpecialists = selectedSpecialists
          .slice(i + 1, i + 3)
          .map((s) => s.role)
          .join(', ');

        const statusUpdate = `**EXECUTIVE STATUS UPDATE**\n\n"${lead.name} here—quick status. The team is hitting their stride. ${specialist.name} just wrapped up their analysis${specialistInputs.length > 1 ? `, building on work from ${completedNames}` : ''}. ${nextSpecialists ? `More coming in now from ${nextSpecialists}.` : 'Moving toward synthesis.'}"`;

        onThinking({
          agent: lead.name,
          role: lead.role || 'Project Lead',
          action: 'collaboration',
          message: `Executive status update from ${lead.name}`,
          collaboration: statusUpdate,
        });
      }
    }

    // If there's a pending critical question, save state and return question
    if (pendingUserQuestion) {
      logger.info(
        `[orchestrateTeamResponse] Returning pending question to user from ${pendingUserQuestion.agent}`,
      );

      // Save orchestration state for resumption
      if (conversationId) {
        const stateToSave = {
          workPlan,
          specialistInputs,
          responses,
          selectedSpecialists: selectedSpecialists.map((s) => ({
            name: s.name,
            role: s.role,
            agentId: s.agentId,
            tier: s.tier,
            instructions: s.instructions,
            expertise: s.expertise,
            responsibilities: s.responsibilities,
            model: s.model,
          })),
          stoppedAtSpecialistIndex,
          pendingQuestion: pendingUserQuestion,
          lead: {
            name: lead.name,
            role: lead.role,
            agentId: lead.agentId,
            tier: lead.tier,
            instructions: lead.instructions,
          },
          originalUserMessage: userMessage,
        };
        saveOrchestrationState(conversationId, stateToSave);
      }

      // Format the question for display
      const optionsArray = Array.isArray(pendingUserQuestion.options)
        ? pendingUserQuestion.options
        : [];
      const optionsText =
        optionsArray.length > 0
          ? '\n\n**Options:**\n' + optionsArray.map((o, i) => `${i + 1}. ${o}`).join('\n')
          : '';

      const questionMessage = `**${pendingUserQuestion.agent}** (${pendingUserQuestion.agentRole}) needs clarification before proceeding:

---

${pendingUserQuestion.question}${optionsText}

---

_Please respond to continue the analysis._`;

      // Stream the question to the user incrementally
      if (onStream) {
        await streamTextIncrementally(questionMessage, onStream);
      }

      return {
        success: true,
        waitingForInput: true,
        pendingQuestion: pendingUserQuestion,
        responses,
        specialistInputs,
        stoppedAtSpecialistIndex,
        selectedSpecialists: selectedSpecialists.map((s) => s.name),
        workPlan,
        formattedResponse: questionMessage,
        selectedAgents: [lead, ...selectedSpecialists.slice(0, stoppedAtSpecialistIndex + 1)].map(
          (a) => ({
            id: a.agentId,
            name: a.name,
            role: a.role,
          }),
        ),
      };
    }

    // PHASE 3: Synthesize with STREAMING (only if no pending questions)
    if (onAgentStart) onAgentStart({ ...lead, phase: 'synthesis' });

    const finalDeliverable = await synthesizeDeliverableStreaming({
      lead,
      userMessage,
      specialistInputs,
      deliverableOutline: workPlan.deliverableOutline,
      apiKey,
      onThinking,
      onStream,
    });

    // Add team credits
    const timestamp = new Date().toISOString().split('T')[0];
    const teamCredits = `\n\n---\n\n_**Team:** ${lead.name} (Lead)${selectedSpecialists.length > 0 ? ', ' + selectedSpecialists.map((s) => s.name).join(', ') : ''} | ${timestamp}_`;

    const formattedResponse = finalDeliverable + teamCredits;

    // Stream the credits
    if (onStream) {
      onStream(teamCredits);
    }

    logger.info(
      `[orchestrateTeamResponse] Completed with ${selectedSpecialists.length + 1} contributors`,
    );

    return {
      success: true,
      waitingForInput: false,
      responses,
      formattedResponse,
      selectedAgents: [lead, ...selectedSpecialists].map((a) => ({
        id: a.agentId,
        name: a.name,
        role: a.role,
      })),
      workPlan,
    };
  } catch (error) {
    logger.error('[orchestrateTeamResponse] Error:', error);
    return {
      success: false,
      error: error.message,
      responses: [],
    };
  }
};

const shouldUseTeamOrchestration = (conversation) => {
  const teamAgents = conversation?.teamAgents;
  return teamAgents && Array.isArray(teamAgents) && teamAgents.length > 0;
};

/**
 * Continue a long markdown response that was cut off by max_tokens
 * Similar to synthesizeDeliverableStreaming but for regular chat responses (not artifacts)
 */
const continueMarkdownResponse = async ({
  apiKey,
  fullText,
  systemPrompt,
  userMessage,
  onStream,
  maxAttempts = 15,
}) => {
  const client = new Anthropic({ apiKey });
  let accumulatedText = fullText;
  let attempts = 0;
  let finishReason = null;

  while (attempts < maxAttempts) {
    const isContinuation = attempts > 0 || accumulatedText.length > 0;
    let messages = [];

    if (isContinuation) {
      const context = getContinuationContext(accumulatedText, 3000);
      const continuationText = context || accumulatedText.substring(Math.max(0, accumulatedText.length - 3000));
      
      messages.push({
        role: 'assistant',
        content: continuationText,
      });

      messages.push({
        role: 'user',
        content: `CRITICAL INSTRUCTIONS FOR CONTINUATION:

1. The previous response was cut off due to token limits. Continue EXACTLY from where it stopped.
2. Do NOT repeat any content that was already written above.
3. Do NOT add new headers, sections, or restart the document.
4. Do NOT duplicate markdown tags, headers (#), list items (-, *, +, 1.), or any other formatting elements.
5. IMPORTANT: Check the last character of the previous text. If it is a letter, digit, or any non-whitespace character that is NOT punctuation (.,;:!?-), you MUST start your continuation with a SPACE to prevent words from being joined together.
6. If the last character is already a space, newline, or punctuation mark, continue normally without adding an extra space.
7. Simply continue writing the content naturally from where it was cut off.
8. Complete the response fully and properly.`,
      });
    } else {
      messages.push({
        role: 'user',
        content: userMessage,
      });
    }

    const stream = client.messages.stream({
      model: ORCHESTRATOR_ANTHROPIC_MODEL,
      max_tokens: 4000,
      system: systemPrompt,
      messages: messages,
    });

    let currentChunk = '';
    let lastEvent = null;
    let isFirstChunk = true;

    for await (const event of stream) {
      lastEvent = event;

      if (event.type === 'content_block_delta' && event.delta?.text) {
        let chunk = event.delta.text;

        if (chunk) {
          currentChunk += chunk;
          accumulatedText += chunk;
          if (onStream) {
            onStream(chunk);
          }
        }
      }

      if (event.type === 'message_stop') {
        finishReason = event.finish_reason || 'end_turn';
      } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
        finishReason = event.delta.stop_reason;
      }
    }

    const isMaxTokens = finishReason === 'max_tokens';
    const isEndTurn = finishReason === 'end_turn';
    const hasNewContent = currentChunk.length > 0;
    const isFirstAttempt = attempts === 0;
    
    const needsContinuation = isMaxTokens || (isEndTurn && isFirstAttempt && hasNewContent);
    
    logger.info(`[continueMarkdownResponse] Attempt ${attempts}: finishReason=${finishReason}, isMaxTokens=${isMaxTokens}, isEndTurn=${isEndTurn}, hasNewContent=${hasNewContent}, needsContinuation=${needsContinuation}, currentChunk.length=${currentChunk.length}`);

    if (!needsContinuation || attempts >= maxAttempts - 1) {
      logger.info(`[continueMarkdownResponse] Response complete or no continuation needed (attempt ${attempts}, finishReason: ${finishReason})`);
      break;
    }

    attempts++;
    logger.info(`[continueMarkdownResponse] Response incomplete, continuing (attempt ${attempts})`);
  }

  return accumulatedText;
};

module.exports = {
  executeLeadAnalysis,
  executeSpecialist,
  synthesizeDeliverableStreaming,
  orchestrateTeamResponse,
  shouldUseTeamOrchestration,
  // State management for resumable orchestrations
  getOrchestrationState,
  saveOrchestrationState,
  clearOrchestrationState,
  // Helper for continuing long markdown responses
  continueMarkdownResponse,
  getContinuationContext,
};
