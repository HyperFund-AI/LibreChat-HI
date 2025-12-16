const { betaZodTool } = require('@anthropic-ai/sdk/helpers/beta/zod');
const { z } = require('zod');
const { logger } = require('@librechat/data-schemas');
const Anthropic = require('@anthropic-ai/sdk');
const {
  readKnowledgeDocumentTool,
  createListDocumentsTool,
  createSearchDocumentsTool,
  createAskUserTool,
} = require('./tools');
const {
  saveOrchestrationState,
  getOrchestrationState,
  clearOrchestrationState,
} = require('~/models');
const { runAgentToolLoop, runAgentToolLoopStreaming } = require('./agentRunner');

const ORCHESTRATOR_ANTHROPIC_MODEL = 'claude-sonnet-4-5';
const ALLOW_DEBUG = true;
const SPECIALISTS_INCLUDE_LEAD = false;
const SPECIALISTS_INCLUDE_QA = false;

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
  messageHistory,
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

  // [DEBUG] Forced Pause Trigger
  if (ALLOW_DEBUG && userMessage.includes('[FORCE_PAUSE]')) {
    logger.info('[executeSpecialist] FORCED PAUSE TRIGGERED');
    const question = 'Debug Verification: Confirming pause logic works at ' + new Date().toISOString();

    // Properly hydrate history with the question so persistence captures it
    const history = [...(messageHistory || [])];
    history.push({
      role: 'assistant',
      content: question,
    });

    return {
      text: '',
      messages: history, // Return history INCLUDING the question
      status: 'PAUSED',
      question: question,
    };
  }

  // Define Tools
  const tools = [
    readKnowledgeDocumentTool,
    createListDocumentsTool(conversationId),
    createSearchDocumentsTool(conversationId),
    createAskUserTool(),
  ];

  logger.info(`[executeSpecialist] Starting streaming loop for ${agent.name}`);

  const initialMessages = messageHistory || [{ role: 'user', content: userContent }];

  // Using streaming loop to allow tools + tokens
  const { result: rawResult, messages: finalMessages } = await runAgentToolLoopStreaming({
    apiKey,
    model: agent.model || ORCHESTRATOR_ANTHROPIC_MODEL,
    systemPrompt,
    messages: initialMessages,
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

  // Check for pause
  if (rawResult && rawResult.status === 'PAUSED') {
    logger.info(`[executeSpecialist] ${agent.name} PAUSED to ask: ${rawResult.question}`);
    return { ...rawResult, messages: finalMessages, thinking: thinkingText }; // Propagate pause up with history AND thinking
  }

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

  // Return structured response
  return {
    text: outputText || accumulatedText,
    messages: finalMessages || [],
    thinking: thinkingText,
    status: 'COMPLETED',
  };
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

const resumeOrchestration = async ({
  conversationId,
  userResponseText,
  teamAgents,
  apiKey,
  onAgentStart,
  onAgentComplete,
  onThinking,
  onStream,
  responseMessageId,
}) => {
  const state = await getOrchestrationState(conversationId);
  if (!state || state.status !== 'PAUSED') {
    throw new Error('No paused orchestration state found');
  }

  logger.info(`[resumeOrchestration] Resuming conversation ${conversationId}`);
  logger.info(`[resumeOrchestration] available teamAgents: ${teamAgents.map((a) => a.name).join(', ')}`);
  logger.info(
    `[resumeOrchestration] paused orchestration states: ${state.specialistStates.map((s) => s.agentName + '(' + s.status + ')').join(', ')}`,
  );

  const { leadPlan, specialistStates, sharedContext } = state;
  const lead = teamAgents.find((a) => parseInt(a.tier) === 3) || teamAgents[0];

  // Do NOT re-filter specialists from teamAgents. Use the saved plan.
  // The specialistStates array contains the EXACT list of agents selected for this flow, in order.

  const specialistInputs = [];

  // Restore completed inputs
  specialistStates
    .filter((s) => s.status === 'COMPLETED')
    .forEach((s) => {
      // Prefer the self-contained definition if available
      let agent = s.agentDefinition;
      if (!agent) {
        agent = teamAgents.find((a) => a.name === s.agentName);
      }

      if (agent) {
        specialistInputs.push({
          name: s.agentName,
          role: agent.role,
          response: s.currentOutput,
          thinking: s.thinking,
          messages: s.messages, // Restore history for context
        });
      } else {
        // Fallback or skip if agent not found
        logger.warn(`[resumeOrchestration] Could not find agent ${s.agentName} in teamAgents or agentDefinition`);
        specialistInputs.push({
          name: s.agentName,
          role: 'Specialist', // Fallback role
          response: s.currentOutput,
        });
      }
    });

  // Identify the full list of specialists from the saved state (for assignment lookup)
  const specialists = specialistStates.map(s => {
    let agent = s.agentDefinition;
    if (!agent) {
      const found = teamAgents.find(a => a.name === s.agentName);
      agent = found ? { ...found } : { name: s.agentName, role: 'Specialist', model: 'claude-3-5-sonnet-20241022', provider: 'anthropic' };
    }
    return agent;
  });

  // Find the paused agent state
  const pausedState = specialistStates.find((s) => s.status === 'PAUSED');

  // Determine starting index (resume from paused, or start of pending if logic changes)
  let startIndex = 0;
  if (pausedState) {
    const pausedIndex = specialistStates.findIndex((s) => s.status === 'PAUSED');
    if (pausedIndex !== -1) startIndex = pausedIndex;
  }

  // The agents to run are the ones from the paused index onwards
  const agentsToProcess = specialists.slice(startIndex);

  for (const specialist of agentsToProcess) {
    // Check if this is the paused/resuming agent
    const isResuming = pausedState && specialist.name === pausedState.agentName;

    // Handle Resuming Agent
    if (isResuming) {
      logger.info(`[resumeOrchestration] Resuming agent ${specialist.name}`);
      if (onAgentStart) onAgentStart(specialist);

      // Hydrate History with User Answer
      const history = [...pausedState.messages]; // Clone
      let toolCallId = 'unknown';

      // Check for last message existence to prevent crash
      if (history.length > 0) {
        const lastMsg = history[history.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && Array.isArray(lastMsg.content)) {
          const toolBlock = lastMsg.content.find(
            (c) => c.type === 'tool_use' && c.name === 'ask_user',
          );
          if (toolBlock) toolCallId = toolBlock.id;
        }
      }

      if (toolCallId !== 'unknown') {
        // Standard flow: Resume from tool call
        history.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolCallId,
              content: userResponseText,
            },
          ],
        });
      } else {
        // Fallback: If no tool call found (e.g. debug pause or empty history),
        // treat user response as a normal message

        // CRITICAL: Ensure the agent knows what it asked.
        // If history is likely empty or missing the question, inject it from interruptQuestion.
        if (pausedState.interruptQuestion) {
          const lastMsg = history[history.length - 1];
          // Only inject if the last message isn't already the question
          if (!lastMsg || lastMsg.role !== 'assistant' || !JSON.stringify(lastMsg).includes(pausedState.interruptQuestion)) {
            logger.info(`[resumeOrchestration] Injecting missing interrupt question into context: "${pausedState.interruptQuestion}"`);
            history.push({
              role: 'assistant',
              content: pausedState.interruptQuestion,
            });
          }
        }

        logger.warn('[resumeOrchestration] No ask_user tool call found in history. Resuming with standard text message.');
        history.push({
          role: 'user',
          content: userResponseText,
        });
      }

      const idx = specialists.indexOf(specialist) + 1;
      const assignment =
        leadPlan.assignments?.[idx.toString()] || leadPlan.assignments?.[idx] || '';

      const specialistResponse = await executeSpecialist({
        agent: specialist,
        assignment,
        userMessage: 'RESUMED',
        apiKey,
        onThinking,
        sharedContext,
        conversationId,
        messageHistory: history,
      });

      // Check for recursive pause
      if (specialistResponse && specialistResponse.status === 'PAUSED') {
        const futureSpecialists = specialists.slice(specialists.indexOf(specialist) + 1);

        return await persistTeamState({
          conversationId,
          parentMessageId: state.parentMessageId,
          leadPlan,
          specialistInputs,
          activeAgent: specialist,
          activeAgentResponse: specialistResponse,
          pendingAgents: futureSpecialists,
          sharedContext,
          leadAgent: lead,
          allSpecialists: specialists,
          pausedMessageId: responseMessageId,
        });
      }

      specialistInputs.push({
        name: specialist.name,
        role: specialist.role,
        response: specialistResponse.text,
        messages: specialistResponse.messages,
      });

      if (onAgentComplete)
        onAgentComplete({
          agentName: specialist.name,
          agentRole: specialist.role,
          response: specialistResponse,
        });
    } else {
      // Normal pending agent execution
      logger.info(`[resumeOrchestration] executing pending agent ${specialist.name}`);
      if (onAgentStart) onAgentStart(specialist);

      const idx = specialists.indexOf(specialist) + 1;
      const assignment =
        leadPlan.assignments?.[idx.toString()] || leadPlan.assignments?.[idx] || '';

      const specialistResponse = await executeSpecialist({
        agent: specialist,
        assignment,
        userMessage: 'RESUMED_PENDING', // Or enrich message again
        apiKey,
        onThinking,
        sharedContext,
        conversationId,
      });

      if (specialistResponse && specialistResponse.status === 'PAUSED') {
        const futureSpecialists = specialists.slice(specialists.indexOf(specialist) + 1);

        return await persistTeamState({
          conversationId,
          parentMessageId: state.parentMessageId,
          leadPlan,
          specialistInputs,
          activeAgent: specialist,
          activeAgentResponse: specialistResponse,
          pendingAgents: futureSpecialists,
          sharedContext,
          leadAgent: lead,
          allSpecialists: specialists,
          pausedMessageId: responseMessageId, // Save the ID of the pause question
        });
      }

      specialistInputs.push({
        name: specialist.name,
        role: specialist.role,
        response: specialistResponse.text,
        messages: specialistResponse.messages,
      });

      if (onAgentComplete)
        onAgentComplete({
          agentName: specialist.name,
          agentRole: specialist.role,
          response: specialistResponse.text,
        });
    }
  }

  // Synthesis
  if (onAgentStart) onAgentStart({ ...lead, phase: 'synthesis' });

  const finalDeliverable = await synthesizeDeliverableStreaming({
    lead,
    userMessage: leadPlan.userMessage || 'Objective',
    specialistInputs,
    deliverableOutline: leadPlan.deliverableOutline,
    apiKey,
    onThinking,
    onStream,
  });

  const timestamp = new Date().toISOString().split('T')[0];
  const teamCredits = `\n\n---\n\n_**Team:** ${lead.name} (Lead)${specialists.length > 0 ? ', ' + specialists.map((s) => s.name).join(', ') : ''} | ${timestamp}_`;
  const formattedResponse = finalDeliverable + teamCredits;

  if (onStream) onStream(teamCredits);

  // We do NOT clear the state here.
  // Keeping it allows the user to go back and "branch" from the same pause point multiple times.
  // await clearOrchestrationState(conversationId, state.parentMessageId);

  return {
    success: true,
    formattedResponse,
    responses: [], // Fill if needed
  };
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
  parentMessageId,
  responseMessageId, // New param
  onAgentStart,
  onAgentComplete,
  onThinking,
  onStream,
}) => {
  try {
    logger.info(`[orchestrateTeamResponse] Starting with ${teamAgents.length} agents. ResponseID: ${responseMessageId}`);

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
    const specialists = teamAgents.filter((a) => {
      const isLead = a.agentId === lead.agentId || parseInt(a.tier) === 3;
      const isQA = parseInt(a.tier) === 5;

      if (isLead && !SPECIALISTS_INCLUDE_LEAD) return false;
      if (isQA && !SPECIALISTS_INCLUDE_QA) return false;

      return true;
    });

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
        conversationId,
      });

      // Handle Pause
      if (specialistResponse && specialistResponse.status === 'PAUSED') {
        const remainingSpecialists = selectedSpecialists.slice(
          selectedSpecialists.indexOf(specialist) + 1,
        );

        const savedResult = await persistTeamState({
          conversationId,
          parentMessageId,
          leadPlan: workPlan,
          specialistInputs,
          activeAgent: specialist,
          activeAgentResponse: specialistResponse,
          pendingAgents: remainingSpecialists,
          sharedContext: workPlan.sharedContext,
          leadAgent: lead,
          allSpecialists: selectedSpecialists,
          pausedMessageId: responseMessageId, // Save the ID of the pause question
        });

        return {
          ...savedResult,
          responses,
        };
      }

      // Success Case
      specialistInputs.push({
        name: specialist.name,
        role: specialist.role,
        response: specialistResponse.text, // Store text for synthesis
        messages: specialistResponse.messages, // Store history for state
      });

      responses.push({
        agentId: specialist.agentId,
        agentName: specialist.name,
        agentRole: specialist.role,
        response: specialistResponse.text,
      });

      if (onAgentComplete)
        onAgentComplete({
          agentName: specialist.name,
          agentRole: specialist.role,
          response: specialistResponse.text,
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

/**
 * Helper to construct and save the paused orchestration state.
 * Reduces duplication across initial execution and resumption flows.
 */
const persistTeamState = async ({
  conversationId,
  parentMessageId,
  leadPlan,
  specialistInputs,
  activeAgent,
  activeAgentResponse,
  pendingAgents,
  sharedContext,
  leadAgent,
  allSpecialists,
  pausedMessageId,
}) => {
  logger.info(`[persistTeamState] Pausing orchestration for ${activeAgent.name}`);

  const specialistStates = [];

  // Add already completed specialists
  specialistInputs.forEach((input) => {
    specialistStates.push({
      agentName: input.name,
      status: 'COMPLETED',
      messages: input.messages || [], // Persist history
      currentOutput: input.response,
      thinking: input.thinking, // Persisted thinking
      agentDefinition: input.agentDefinition, // Ensure completed agents have definitions too if tracked
    });
  });

  // Add the currently paused specialist
  specialistStates.push({
    agentName: activeAgent.name,
    status: 'PAUSED',
    messages: activeAgentResponse.messages || [],
    interruptQuestion: activeAgentResponse.question,
    thinking: activeAgentResponse.thinking, // Persist thinking state
    agentDefinition: activeAgent, // Save full active agent definition
  });

  // Add pending specialists
  pendingAgents.forEach((s) => {
    specialistStates.push({
      agentName: s.name,
      status: 'PENDING',
      messages: [],
      currentOutput: '', // Consistent with other states
    });
  });

  await saveOrchestrationState({
    conversationId,
    parentMessageId,
    pausedMessageId, // Save the resume key
    status: 'PAUSED',
    leadPlan,
    specialistStates,
    sharedContext,
  });

  // Gracefully handle missing lead/specialists
  const safeAgents = [leadAgent, ...(allSpecialists || [])].filter(Boolean);

  return {
    success: true,
    isPaused: true,
    message: activeAgentResponse.question,
    formattedResponse: '', // Safe empty response
    // Return full agent objects as expected by frontend/controller
    selectedAgents: safeAgents.map((a) => ({
      id: a.agentId,
      name: a.name,
      role: a.role,
    })),
  };
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
  resumeOrchestration,
  shouldUseTeamOrchestration,
};
