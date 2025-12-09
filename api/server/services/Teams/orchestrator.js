const { logger } = require('@librechat/data-schemas');
const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

/**
 * Team Orchestrator - Smart Collaboration Flow
 * 
 * 1. Project Lead analyzes objective and selects relevant specialists
 * 2. Only selected specialists contribute their expertise
 * 3. Project Lead synthesizes all input into ONE unified deliverable
 */

/**
 * Phase 1: Lead analyzes objective and creates work plan
 */
const executeLeadAnalysis = async ({ lead, userMessage, apiKey, teamAgents }) => {
  const specialistList = teamAgents
    .filter(a => parseInt(a.tier) !== 3) // Exclude lead
    .map((a, i) => `${i + 1}. ${a.name} (${a.role}): ${a.expertise || a.responsibilities || 'Specialist'}`)
    .join('\n');

  const systemPrompt = `You are ${lead.name}, ${lead.role}.

${lead.instructions || ''}

You are the Project Lead. Your job is to:
1. Analyze the user's objective
2. Decide which team specialists are needed (you don't need all of them!)
3. Create clear assignments for each selected specialist

Available Specialists:
${specialistList}

IMPORTANT: Respond in this EXACT JSON format:
{
  "analysis": "Brief analysis of what the objective requires",
  "selectedSpecialists": [1, 2], // Array of specialist numbers (1-indexed) that are NEEDED
  "assignments": {
    "1": "Specific task for specialist 1",
    "2": "Specific task for specialist 2"
  },
  "deliverableOutline": "Brief outline of the final deliverable structure"
}

Only select specialists whose expertise is genuinely needed. For simple tasks, you might only need 1-2 specialists.`;

  const client = new Anthropic({ apiKey });
  
  const response = await client.messages.create({
    model: DEFAULT_ANTHROPIC_MODEL,
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Objective: ${userMessage}` }],
  });

  const responseText = response.content[0]?.text || '';
  
  // Parse JSON from response
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    logger.warn('[executeLeadAnalysis] Could not parse JSON, using all specialists');
  }
  
  // Fallback: use all specialists
  const allIndices = teamAgents
    .filter(a => parseInt(a.tier) !== 3)
    .map((_, i) => i + 1);
  
  return {
    analysis: responseText,
    selectedSpecialists: allIndices,
    assignments: {},
    deliverableOutline: 'Comprehensive analysis',
  };
};

/**
 * Phase 2: Execute selected specialists
 */
const executeSpecialist = async ({ agent, assignment, userMessage, apiKey }) => {
  const systemPrompt = `You are ${agent.name}, a ${agent.role}.

${agent.instructions || ''}

Your expertise: ${agent.expertise || agent.responsibilities || 'Specialist'}

You have been assigned a specific task by the Project Lead.

Guidelines:
- Focus ONLY on your assigned area
- Be specific, actionable, and data-driven
- Use bullet points and clear structure
- Keep response focused (200-400 words)
- Provide insights only YOU as a specialist can provide`;

  const client = new Anthropic({ apiKey });
  
  const response = await client.messages.create({
    model: agent.model || DEFAULT_ANTHROPIC_MODEL,
    max_tokens: 1200,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Overall Objective: ${userMessage}\n\nYour Specific Assignment: ${assignment || 'Provide your specialist analysis on this objective.'}`,
    }],
  });

  return response.content[0]?.text || '';
};

/**
 * Phase 3: Lead synthesizes into final deliverable
 */
const synthesizeDeliverable = async ({ lead, userMessage, specialistInputs, deliverableOutline, apiKey }) => {
  const inputsSummary = specialistInputs
    .map(s => `### ${s.name} (${s.role})\n${s.response}`)
    .join('\n\n---\n\n');

  const systemPrompt = `You are ${lead.name}, ${lead.role}.

You have received input from your specialist team. Your job is to synthesize their contributions into ONE cohesive, professional deliverable.

DO NOT just combine their responses. Create a UNIFIED document that:
1. Has a clear executive summary
2. Integrates insights from all specialists seamlessly
3. Provides actionable recommendations
4. Is written as ONE coherent narrative
5. Uses proper Markdown formatting

The deliverable should read as if written by one expert, not as separate sections from different people.`;

  const client = new Anthropic({ apiKey });
  
  const response = await client.messages.create({
    model: DEFAULT_ANTHROPIC_MODEL,
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `# Objective
${userMessage}

# Deliverable Structure
${deliverableOutline || 'Professional analysis document'}

# Specialist Inputs

${inputsSummary}

---

Now synthesize all of this into ONE unified, professional deliverable document in Markdown format. Do not reference "the team" or "specialists said" - write it as a cohesive document.`,
    }],
  });

  return response.content[0]?.text || '';
};

/**
 * Main orchestration function
 */
const orchestrateTeamResponse = async ({
  userMessage,
  teamAgents,
  conversationHistory,
  fileContext,
  config,
  onAgentStart,
  onAgentComplete,
}) => {
  try {
    logger.info(`[orchestrateTeamResponse] Starting smart orchestration with ${teamAgents.length} agents`);

    const apiKey = config?.endpoints?.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('Anthropic API key not configured');
    }

    // Find the lead and specialists
    const lead = teamAgents.find(a => parseInt(a.tier) === 3);
    const specialists = teamAgents.filter(a => parseInt(a.tier) !== 3 && parseInt(a.tier) !== 5);
    const qa = teamAgents.find(a => parseInt(a.tier) === 5);

    if (!lead) {
      // No lead - use first agent as lead
      logger.warn('[orchestrateTeamResponse] No lead found, using first agent');
    }

    const actualLead = lead || teamAgents[0];
    const responses = [];

    // PHASE 1: Lead Analysis
    if (onAgentStart) onAgentStart({ ...actualLead, phase: 'analyzing' });
    
    logger.info(`[orchestrateTeamResponse] Phase 1: Lead (${actualLead.name}) analyzing objective`);
    const workPlan = await executeLeadAnalysis({
      lead: actualLead,
      userMessage,
      apiKey,
      teamAgents,
    });

    responses.push({
      agentId: actualLead.agentId,
      agentName: actualLead.name,
      agentRole: actualLead.role,
      response: `**Work Plan:** ${workPlan.analysis}`,
      phase: 'planning',
    });

    if (onAgentComplete) onAgentComplete({
      agentName: actualLead.name,
      agentRole: actualLead.role,
      response: `Analyzing objective and selecting team members...`,
      phase: 'planning',
    });

    // PHASE 2: Execute Selected Specialists
    const selectedIndices = workPlan.selectedSpecialists || [];
    const selectedSpecialists = selectedIndices
      .map(idx => specialists[idx - 1])
      .filter(Boolean);

    logger.info(`[orchestrateTeamResponse] Phase 2: Executing ${selectedSpecialists.length} specialists`);

    const specialistInputs = [];
    
    for (const specialist of selectedSpecialists) {
      if (onAgentStart) onAgentStart(specialist);
      
      const assignment = workPlan.assignments?.[selectedIndices.indexOf(specialists.indexOf(specialist) + 1) + 1] || '';
      
      const specialistResponse = await executeSpecialist({
        agent: specialist,
        assignment,
        userMessage,
        apiKey,
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
        phase: 'analysis',
      });

      if (onAgentComplete) onAgentComplete({
        agentName: specialist.name,
        agentRole: specialist.role,
        response: `Completed specialist analysis`,
        phase: 'analysis',
      });
    }

    // PHASE 3: Synthesize Final Deliverable
    if (onAgentStart) onAgentStart({ ...actualLead, phase: 'synthesizing' });
    
    logger.info(`[orchestrateTeamResponse] Phase 3: Lead synthesizing deliverable`);
    
    const finalDeliverable = await synthesizeDeliverable({
      lead: actualLead,
      userMessage,
      specialistInputs,
      deliverableOutline: workPlan.deliverableOutline,
      apiKey,
    });

    if (onAgentComplete) onAgentComplete({
      agentName: actualLead.name,
      agentRole: actualLead.role,
      response: `Deliverable complete`,
      phase: 'synthesis',
    });

    // Format final response
    const timestamp = new Date().toISOString().split('T')[0];
    const teamCredits = `\n\n---\n\n_**Team Contributors:** ${actualLead.name} (Lead)${selectedSpecialists.length > 0 ? ', ' + selectedSpecialists.map(s => s.name).join(', ') : ''}_\n_**Generated:** ${timestamp}_`;

    const formattedResponse = finalDeliverable + teamCredits;

    logger.info(`[orchestrateTeamResponse] Completed - ${selectedSpecialists.length + 1} agents contributed`);

    return {
      success: true,
      responses,
      formattedResponse,
      selectedAgents: [actualLead, ...selectedSpecialists].map(a => ({ 
        id: a.agentId, 
        name: a.name, 
        role: a.role 
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
 * Checks if a conversation should use team orchestration
 */
const shouldUseTeamOrchestration = (conversation) => {
  const teamAgents = conversation?.teamAgents;
  return teamAgents && Array.isArray(teamAgents) && teamAgents.length > 0;
};

module.exports = {
  executeLeadAnalysis,
  executeSpecialist,
  synthesizeDeliverable,
  orchestrateTeamResponse,
  shouldUseTeamOrchestration,
};
