const { fixJSONObject } = require('~/server/utils/jsonRepair');
const { betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');
const { z } = require('zod');
const { logger } = require('@librechat/data-schemas');
const Anthropic = require('@anthropic-ai/sdk');

const ORCHESTRATOR_ANTHROPIC_MODEL = 'claude-sonnet-4-5';

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
 * Phase 2: Execute selected specialists with visible progress and streaming thinking
 * Now supports collaborative chain - each specialist sees previous contributions
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
}) => {
  logger.info(
    `[executeSpecialist] Called for ${agent.name}, onThinking callback: ${onThinking ? 'present' : 'MISSING'}, previous contributions: ${previousContributions.length}`,
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

  const systemPrompt = `You are ${agent.name}, a ${agent.role}.

${agent.instructions || ''}

Your expertise: ${agent.expertise || agent.responsibilities || 'Specialist'}

IMPORTANT: Structure your response in two clear sections:

<THINKING>
Your step-by-step thinking process here. Show your reasoning, considerations, and approach.
${previousContributions.length > 0 ? 'Consider what previous specialists have contributed and how your expertise adds to or builds upon their work.' : ''}
</THINKING>

<OUTPUT>
Your final expert analysis/output here in Markdown format.
</OUTPUT>

Guidelines:
- Put your reasoning process in the THINKING section
- Put your final deliverable in the OUTPUT section
- Focus on your assigned area while being aware of the broader context
- Be specific and data-driven
- Use bullet points in the output
- Keep output focused (200-300 words)
- Provide expert insights
${collaborationGuidelines}`;

  const client = new Anthropic({ apiKey });

  let accumulatedText = '';
  let thinkingText = '';
  let outputText = '';
  let lastThinkingSent = '';
  let chunkCount = 0;

  // Build the user message with all available context
  const hasContext = previousContributions.length > 0 || conversationContext || additionalContext;
  const userContent = hasContext
    ? `# Objective\n${userMessage}\n\n# Your Assignment\n${assignment || 'Provide your specialist analysis.'}\n\n${additionalContext}${conversationContext}${collaborationContext}`
    : `Objective: ${userMessage}\n\nYour Assignment: ${assignment || 'Provide your specialist analysis.'}`;

  // Use streaming to get real-time thinking process
  const stream = client.messages.stream({
    model: agent.model || ORCHESTRATOR_ANTHROPIC_MODEL,
    max_tokens: 2000,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: userContent,
      },
    ],
  });

  logger.info(`[executeSpecialist] Starting stream for ${agent.name}`);

  // Stream each chunk and extract thinking in real-time
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.text) {
      const chunk = event.delta.text;
      accumulatedText += chunk;
      chunkCount++;

      // Log every 10 chunks to show progress
      if (chunkCount % 10 === 0) {
        logger.info(
          `[executeSpecialist] ${agent.name} received ${chunkCount} chunks, ${accumulatedText.length} chars total`,
        );
      }

      // Try to extract thinking section as it streams
      const thinkingMatch = accumulatedText.match(/<THINKING>([\s\S]*?)(?:<\/THINKING>|$)/i);
      if (thinkingMatch && thinkingMatch[1]) {
        const currentThinking = thinkingMatch[1].trim();

        // Send updates every few chunks or when thinking content grows significantly
        if (currentThinking.length > lastThinkingSent.length + 50 || chunkCount % 5 === 0) {
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
    }
  }

  // Final extraction
  const finalThinkingMatch = accumulatedText.match(/<THINKING>([\s\S]*?)<\/THINKING>/i);
  const finalOutputMatch = accumulatedText.match(/<OUTPUT>([\s\S]*?)<\/OUTPUT>/i);

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
    logger.warn(
      `[executeSpecialist] No THINKING/OUTPUT tags found for ${agent.name}, using raw response`,
    );
    outputText = accumulatedText;
  } else if (!outputText) {
    // If we have thinking but no output, the output might come after thinking without tags
    const afterThinking = accumulatedText.replace(/<THINKING>[\s\S]*?<\/THINKING>/i, '').trim();
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

const isArtifactComplete = (text) => {
  const artifactStart = text.indexOf(':::artifact');
  if (artifactStart === -1) return false;
  
  const afterStart = text.substring(artifactStart + 11);
  const closingTagIndex = afterStart.indexOf(':::');
  return closingTagIndex !== -1;
};

const getContinuationContext = (text, maxContextLength = 1500) => {
  const artifactStart = text.indexOf(':::artifact');
  if (artifactStart === -1) return '';
  
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
  const maxAttempts = 4;

  while (attempts < maxAttempts) {
    const isContinuation = attempts > 0;
    let messages = [];
    
    if (isContinuation) {
      const context = getContinuationContext(fullText, 3000);
      const artifactStart = fullText.indexOf(':::artifact');
      const introText = artifactStart > 0 ? fullText.substring(0, artifactStart) : '';
      const continuationText = introText + (context || fullText.substring(Math.max(0, fullText.length - 3000)));
      
      messages.push({
        role: 'assistant',
        content: continuationText,
      });
      
      messages.push({
        role: 'user',
        content: 'Continue generating from where you left off. Complete the document and make sure to properly close the artifact tag with ::: at the end.',
      });
      
      if (onThinking) {
        onThinking({
          agent: lead.name,
          action: 'continuing',
          message: `Continuing artifact generation (attempt ${attempts + 1})...`,
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

    for await (const event of stream) {
      lastEvent = event;
      
      if (event.type === 'content_block_delta' && event.delta?.text) {
        const chunk = event.delta.text;
        currentChunk += chunk;
        fullText += chunk;
        if (onStream) {
          onStream(chunk);
        }
      }
      
      if (event.type === 'message_stop' || event.type === 'message_delta') {
        finishReason = event.finish_reason || event.delta?.stop_reason;
      }
    }

    const isComplete = isArtifactComplete(fullText);
    const needsContinuation = finishReason === 'max_tokens' || (!isComplete && currentChunk.length > 0);
    
    if (isComplete || !needsContinuation || attempts >= maxAttempts - 1) {
      logger.info(`[synthesizeDeliverableStreaming] Artifact complete or no continuation needed, breaking (attempt ${attempts})`);
      break;
    }
    
    attempts++;
    logger.info(`[synthesizeDeliverableStreaming] Artifact incomplete, continuing (attempt ${attempts})`);
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
 * Main orchestration function with visible collaboration
 */
const orchestrateTeamResponse = async ({
  userMessage,
  teamAgents,
  conversationHistory,
  fileContext,
  knowledgeContext,
  config,
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

    const lead = teamAgents.find((a) => parseInt(a.tier) === 3) || teamAgents[0];
    const specialists = teamAgents.filter((a) => parseInt(a.tier) !== 3 && parseInt(a.tier) !== 5);

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

    // Execute specialists in a collaborative chain - each sees previous contributions
    for (let i = 0; i < selectedSpecialists.length; i++) {
      const specialist = selectedSpecialists[i];
      if (onAgentStart) onAgentStart(specialist);

      const idx = specialists.indexOf(specialist) + 1;
      const assignment =
        workPlan.assignments?.[idx.toString()] || workPlan.assignments?.[idx] || '';

      // Pass previous contributions and all context to enable collaboration chain
      const specialistResponse = await executeSpecialist({
        agent: specialist,
        assignment,
        userMessage,
        apiKey,
        onThinking,
        previousContributions: [...specialistInputs], // Clone to avoid mutation issues
        conversationHistory,
        fileContext,
        knowledgeContext,
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

      logger.info(
        `[orchestrateTeamResponse] Specialist ${i + 1}/${selectedSpecialists.length} (${specialist.name}) completed. Chain progress: ${specialistInputs.length} contributions accumulated.`,
      );
    }

    // PHASE 3: Synthesize with STREAMING
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
