const { betaZodTool } = require('@anthropic-ai/sdk/helpers/beta/zod');
const { z } = require('zod');
const { logger } = require('@librechat/data-schemas');
const Anthropic = require('@anthropic-ai/sdk');
const {
  readKnowledgeDocumentTool,
  createListDocumentsTool,
  createSearchDocumentsTool,
} = require('./tools');
const { runAgentToolLoop, runAgentToolLoopStreaming } = require('./agentRunner');

const ORCHESTRATOR_ANTHROPIC_MODEL = 'claude-sonnet-4-5';

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
  conversationId,
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
- Each specialist should have a clear, distinct role in addressing the objective`;

  // Define Tools
  const submissionTool = {
    ...betaZodTool({
      name: 'submit_lead_analysis',
      description: 'Submit the final analysis and specialist selection plan.',
      inputSchema: zLeadAnalysisSchema,
      run: async (args) => args, // Dummy run, intercepted by agentRunner TODO: use the beta toolRunner or whatnot
    }),
    usage: 'submit your final analysis and specialist selection.',
  };

  const tools = [
    readKnowledgeDocumentTool,
    createListDocumentsTool(conversationId),
    createSearchDocumentsTool(conversationId),
    submissionTool,
  ];

  // Run the Agent Loop
  const { result: finalPlan, messages: leadHistory } = await runAgentToolLoop({
    apiKey,
    model: ORCHESTRATOR_ANTHROPIC_MODEL,
    systemPrompt,
    messages: [{ role: 'user', content: `Objective: ${userMessage} ` }],
    tools,
    submissionToolName: 'submit_lead_analysis',
    agentName: lead.name,
    onThinking,
    toolChoice: 'any',
  });

  // Extract collected context from history
  let sharedContext = '';
  if (leadHistory && leadHistory.length > 0) {
    const docResults = [];
    for (const msg of leadHistory) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result' && typeof block.content === 'string') {
            if (
              block.content.startsWith('### Document:') ||
              block.content.startsWith('### Search Results')
            ) {
              docResults.push(block.content);
            }
          }
        }
      }
    }
    if (docResults.length > 0) {
      sharedContext = docResults.join('\n\n');
    }
  }

  if (finalPlan) {
    if (onThinking) {
      onThinking({
        agent: lead.name,
        action: 'planned',
        message: `Selected ${finalPlan.selectedSpecialists?.length || 0} specialists based on analysis`,
      });
    }
    return { ...finalPlan, sharedContext };
  }

  // Fallback: Select at least 2-3 specialists if parsing failed
  const availableSpecialists = teamAgents.filter((a) => parseInt(a.tier) !== 3);
  const allIndices = availableSpecialists.map((_, i) => i + 1);
  // Ensure we have at least 2-3 specialists selected
  const minSpecialists = Math.min(3, Math.max(2, availableSpecialists.length));
  const selectedIndices = allIndices.slice(0, minSpecialists);

  return {
    analysis: 'Analysis loop completed without structured output.',
    selectedSpecialists: selectedIndices,
    assignments: {},
    deliverableOutline: 'Comprehensive analysis (Fallback)',
    sharedContext: '',
  };
};

/**
 * Phase 2: Execute selected specialists with visible progress and streaming thinking
 */
const executeSpecialist = async ({
  agent,
  assignment,
  userMessage,
  sharedContext,
  apiKey,
  onThinking,
  conversationId,
}) => {
  logger.info(
    `[executeSpecialist] Called for ${agent.name}, onThinking callback: ${onThinking ? 'present' : 'MISSING'}`,
  );

  if (onThinking) {
    onThinking({
      agent: agent.name,
      role: agent.role,
      action: 'working',
      message: assignment || `Analyzing from ${agent.role} perspective...`,
    });
  }

  const systemPrompt = `You are ${agent.name}, a ${agent.role}.

${agent.instructions || ''}

Your expertise: ${agent.expertise || agent.responsibilities || 'Specialist'}

IMPORTANT: Structure your response in two clear sections:

<THINKING>
Your step-by-step thinking process here. Show your reasoning, considerations, and approach.
</THINKING>

<OUTPUT>
Your final expert analysis/output here in Markdown format.
</OUTPUT>

Guidelines:
- Put your reasoning process in the THINKING section
- Put your final deliverable in the OUTPUT section
- Focus ONLY on your assigned area
- Be specific and data-driven
- Use bullet points in the output
- Keep output focused (200-300 words)
- Provide expert insights`;

  let accumulatedText = '';
  let thinkingText = '';
  let outputText = '';
  let lastThinkingSent = '';
  let chunkCount = 0;

  // Construct user content with shared context if available
  let userContent = `Objective: ${userMessage}\n\nYour Assignment: ${assignment || 'Provide your specialist analysis.'}`;
  if (sharedContext) {
    userContent += `\n\n# Shared Context (Documents Loaded by Lead)\n\n${sharedContext}`;
  }

  // Define Tools
  const tools = [
    readKnowledgeDocumentTool,
    createListDocumentsTool(conversationId),
    createSearchDocumentsTool(conversationId),
  ];

  logger.info(`[executeSpecialist] Starting streaming loop for ${agent.name}`);

  // Using streaming loop to allow tools + tokens
  const { result: rawResult } = await runAgentToolLoopStreaming({
    apiKey,
    model: agent.model || ORCHESTRATOR_ANTHROPIC_MODEL,
    systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    tools,
    agentName: agent.name,
    onThinking,
    // Provide an onStream handler to capture token deltas
    onStream: (chunk) => {
      accumulatedText += chunk;
      chunkCount++;

      // Log occasionally
      if (chunkCount % 20 === 0) {
        logger.debug(`[executeSpecialist] ${agent.name} stream chunk ${chunkCount}`);
      }

      // Try to extract thinking section as it streams
      const thinkingMatch = accumulatedText.match(/<THINKING>([\s\S]*?)(?:<\/THINKING>|$)/i);
      if (thinkingMatch && thinkingMatch[1]) {
        const currentThinking = thinkingMatch[1].trim();
        // Update UI if we have new thinking content of significance
        if (currentThinking.length > lastThinkingSent.length + 50 || chunkCount % 10 === 0) {
          thinkingText = currentThinking;
          lastThinkingSent = currentThinking;
          if (onThinking) {
            logger.info(
              `[executeSpecialist] Sending thinking update for ${agent.name}: ${currentThinking.length} chars`,
            );
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
    },
    toolChoice: 'auto',
  });

  // Final text is in the result (or fallback to accumulated)
  const finalFullText = rawResult || accumulatedText;

  // Final extraction of THINKING vs OUTPUT
  const finalThinkingMatch = finalFullText.match(/<THINKING>([\s\S]*?)<\/THINKING>/i);
  const finalOutputMatch = finalFullText.match(/<OUTPUT>([\s\S]*?)<\/OUTPUT>/i);

  if (finalThinkingMatch) {
    thinkingText = finalThinkingMatch[1].trim();
  }
  if (finalOutputMatch) {
    outputText = finalOutputMatch[1].trim();
  }

  logger.info(
    `[executeSpecialist] ${agent.name} stream complete. Total: ${accumulatedText.length} chars, ${chunkCount} chunks`,
  );
  logger.info(
    `[executeSpecialist] ${agent.name} has THINKING tag: ${accumulatedText.includes('<THINKING>')}, has OUTPUT tag: ${accumulatedText.includes('<OUTPUT>')}`,
  );

  // If no tags found, try to use the whole response as output
  if (!outputText && !thinkingText) {
    logger.warn(`[executeSpecialist] No tags found for ${agent.name}, using raw text`);
    outputText = finalFullText;
  } else if (!outputText) {
    // If we have thinking but no output, the output might come after thinking without tags
    const afterThinking = finalFullText.replace(/<THINKING>[\s\S]*?<\/THINKING>/i, '').trim();
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

  // Return only the output part (or fallback to accumulated text)
  return outputText || accumulatedText;
};

/**
 * Phase 3: Lead synthesizes into final deliverable WITH STREAMING
 */
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

If there is no deliverable ready - for example, more information from the user was requested in order to produce it, do not produce an artifact.
`;

  const client = new Anthropic({ apiKey });

  let fullText = '';

  // Use streaming for the synthesis
  const stream = client.messages.stream({
    model: ORCHESTRATOR_ANTHROPIC_MODEL,
    max_tokens: 4000,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `# Objective\n${userMessage}\n\n# Deliverable Structure\n${deliverableOutline || 'Professional analysis document'}\n\n# Specialist Inputs\n\n${inputsSummary}\n\n---\n\nSynthesize into ONE unified deliverable document in Markdown format.`,
      },
    ],
  });

  // Stream each chunk
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.text) {
      const chunk = event.delta.text;
      fullText += chunk;
      if (onStream) {
        onStream(chunk);
      }
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
 * Main orchestration function with visible collaboration
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
    logger.info(`[orchestrateTeamResponse] Starting with ${teamAgents.length} agents`);

    const apiKey = config?.endpoints?.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('Anthropic API key not configured');
    }

    // Include knowledge context in the message if available
    let enrichedMessage = userMessage;
    if (knowledgeContext && knowledgeContext.trim()) {
      logger.info('[orchestrateTeamResponse] Injecting team knowledge context');
      enrichedMessage = `${userMessage}\n\n${knowledgeContext}`;
    }

    const lead = teamAgents.find((a) => parseInt(a.tier) === 3) || teamAgents[0];
    const specialists = teamAgents.filter((a) => parseInt(a.tier) !== 3 && parseInt(a.tier) !== 5);

    const responses = [];

    // PHASE 1: Lead Analysis
    if (onAgentStart) onAgentStart(lead);

    const workPlan = await executeLeadAnalysis({
      lead,
      userMessage: enrichedMessage,
      apiKey,
      teamAgents,
      onThinking,
      conversationId,
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

    for (const specialist of selectedSpecialists) {
      if (onAgentStart) onAgentStart(specialist);

      const idx = specialists.indexOf(specialist) + 1;
      const assignment =
        workPlan.assignments?.[idx.toString()] || workPlan.assignments?.[idx] || '';

      const specialistResponse = await executeSpecialist({
        agent: specialist,
        assignment,
        userMessage: enrichedMessage,
        apiKey,
        onThinking,
        sharedContext: workPlan.sharedContext,
      });

      specialistInputs.push({
        name: specialist.name,
        role: specialist.role,
        response: specialistResponse,
      });

      responses.push({
        agentId: specialist.agentId,
        agentName: specialist.name,
        agentRole: specialist.role,
        response: specialistResponse,
      });

      if (onAgentComplete)
        onAgentComplete({
          agentName: specialist.name,
          agentRole: specialist.role,
          response: specialistResponse,
        });
    }

    // PHASE 3: Synthesize with STREAMING
    if (onAgentStart) onAgentStart({ ...lead, phase: 'synthesis' });

    const finalDeliverable = await synthesizeDeliverableStreaming({
      lead,
      userMessage: enrichedMessage,
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

module.exports = {
  executeLeadAnalysis,
  executeSpecialist,
  synthesizeDeliverableStreaming,
  orchestrateTeamResponse,
  shouldUseTeamOrchestration,
};
