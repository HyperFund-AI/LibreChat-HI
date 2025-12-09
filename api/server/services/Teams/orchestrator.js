const { logger } = require('@librechat/data-schemas');
const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

/**
 * Team Orchestrator - Coordinates multi-agent collaboration
 * 
 * All team members contribute to every objective:
 * 1. Project Lead analyzes and creates work plan
 * 2. Each specialist contributes from their expertise
 * 3. QA reviews and validates
 * 4. Final deliverable is compiled as Markdown
 */

/**
 * Executes a single team agent and gets their response
 * @param {Object} params
 * @returns {Promise<Object>} Agent response with metadata
 */
const executeTeamAgent = async ({ 
  agent, 
  userMessage, 
  conversationHistory, 
  previousResponses,
  projectContext,
  apiKey,
  isLead,
  isQA,
}) => {
  try {
    logger.info(`[executeTeamAgent] Executing: ${agent.name} (${agent.role})`);

    let roleContext = '';
    if (isLead) {
      roleContext = `
As the Project Lead, you are FIRST to respond. Your job is to:
1. Analyze the user's objective
2. Break it down into key areas that need to be addressed
3. Outline what each team member should focus on
4. Set the strategic direction

Format your response as:
## Project Analysis
[Your analysis of the objective]

## Work Allocation
[Brief description of what each team member should address]

## Key Questions to Answer
[List the main questions this analysis should answer]
`;
    } else if (isQA) {
      roleContext = `
As Quality Assurance, you are LAST to respond. Your job is to:
1. Review all team members' contributions
2. Identify any gaps or inconsistencies
3. Synthesize the key findings
4. Provide final recommendations

Previous team contributions:
${previousResponses.map(r => `### ${r.agentName} (${r.agentRole})\n${r.response}`).join('\n\n')}

Format your response as:
## Quality Review
[Your assessment of the team's analysis]

## Key Findings Summary
[Synthesized findings from all team members]

## Final Recommendations
[Actionable recommendations based on team analysis]
`;
    } else {
      roleContext = `
The Project Lead has set the direction. Previous team contributions:
${previousResponses.map(r => `### ${r.agentName} (${r.agentRole})\n${r.response}`).join('\n\n')}

As ${agent.role}, provide your specialized analysis. Build on what others have said and add your unique expertise.

Format your response with clear headers for your area of expertise.
`;
    }

    const systemPrompt = `You are ${agent.name}, a ${agent.role}.

${agent.instructions || ''}

Your expertise: ${agent.expertise || agent.responsibilities || 'General specialist'}

${roleContext}

Guidelines:
- Be specific and actionable
- Use bullet points and clear structure
- Reference data and facts when possible
- Keep your response focused (300-500 words max)
- Use Markdown formatting`;

    const client = new Anthropic({ apiKey });
    
    const response = await client.messages.create({
      model: agent.model || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Objective: ${userMessage}\n\n${projectContext ? `Context:\n${projectContext}` : ''}`,
        },
      ],
    });

    const responseText = response.content[0]?.text || '';
    
    logger.info(`[executeTeamAgent] ${agent.name} responded (${responseText.length} chars)`);

    return {
      agentId: agent.agentId,
      agentName: agent.name,
      agentRole: agent.role,
      response: responseText,
      tier: agent.tier,
    };
  } catch (error) {
    logger.error(`[executeTeamAgent] Error from ${agent.name}:`, error);
    return {
      agentId: agent.agentId,
      agentName: agent.name,
      agentRole: agent.role,
      response: `[Unable to generate response: ${error.message}]`,
      error: true,
    };
  }
};

/**
 * Orchestrates full team collaboration - ALL agents participate
 * @param {Object} params
 * @returns {Promise<Object>} Complete team response
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
    logger.info(`[orchestrateTeamResponse] Starting with ${teamAgents.length} agents`);

    const apiKey = config?.endpoints?.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('Anthropic API key not configured');
    }

    // Sort agents by tier: Lead (3) first, then Specialists (4), then QA (5)
    const sortedAgents = [...teamAgents].sort((a, b) => {
      const tierA = parseInt(a.tier) || 4;
      const tierB = parseInt(b.tier) || 4;
      return tierA - tierB;
    });

    const responses = [];
    
    // Execute ALL agents in order
    for (let i = 0; i < sortedAgents.length; i++) {
      const agent = sortedAgents[i];
      const tier = parseInt(agent.tier) || 4;
      const isLead = tier === 3;
      const isQA = tier === 5;

      // Notify UI
      if (onAgentStart) {
        onAgentStart(agent);
      }

      const agentResponse = await executeTeamAgent({
        agent,
        userMessage,
        conversationHistory,
        previousResponses: responses,
        projectContext: fileContext,
        apiKey,
        isLead,
        isQA,
      });

      responses.push(agentResponse);

      if (onAgentComplete) {
        onAgentComplete(agentResponse);
      }
    }

    // Format as comprehensive Markdown document
    const formattedResponse = formatAsMarkdownDocument(userMessage, responses);

    logger.info(`[orchestrateTeamResponse] Completed with ${responses.length} responses`);

    return {
      success: true,
      responses,
      formattedResponse,
      selectedAgents: sortedAgents.map(a => ({ id: a.agentId, name: a.name, role: a.role })),
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
 * Formats all agent responses as a professional Markdown document
 */
const formatAsMarkdownDocument = (objective, responses) => {
  const timestamp = new Date().toISOString().split('T')[0];
  
  // Separate by tier
  const leadResponses = responses.filter(r => parseInt(r.tier) === 3);
  const specialistResponses = responses.filter(r => parseInt(r.tier) === 4 || !r.tier);
  const qaResponses = responses.filter(r => parseInt(r.tier) === 5);

  let markdown = `# Team Analysis Report

**Date:** ${timestamp}  
**Objective:** ${objective}

---

`;

  // Project Lead Section
  if (leadResponses.length > 0) {
    markdown += `## 📋 Project Leadership\n\n`;
    for (const r of leadResponses) {
      markdown += `### ${r.agentName}\n_${r.agentRole}_\n\n${r.response}\n\n`;
    }
    markdown += `---\n\n`;
  }

  // Specialist Analysis Section
  if (specialistResponses.length > 0) {
    markdown += `## 🔬 Specialist Analysis\n\n`;
    for (const r of specialistResponses) {
      markdown += `### ${r.agentName}\n_${r.agentRole}_\n\n${r.response}\n\n---\n\n`;
    }
  }

  // QA Review Section
  if (qaResponses.length > 0) {
    markdown += `## ✅ Quality Assurance Review\n\n`;
    for (const r of qaResponses) {
      markdown += `### ${r.agentName}\n_${r.agentRole}_\n\n${r.response}\n\n`;
    }
    markdown += `---\n\n`;
  }

  // Footer
  markdown += `
---

*This report was generated by your Superhuman Team. Each section represents the expert analysis of a specialized team member.*

**Team Members:** ${responses.map(r => r.agentName).join(', ')}
`;

  return markdown;
};

/**
 * Checks if a conversation should use team orchestration
 */
const shouldUseTeamOrchestration = (conversation) => {
  const teamAgents = conversation?.teamAgents;
  return teamAgents && Array.isArray(teamAgents) && teamAgents.length > 0;
};

module.exports = {
  executeTeamAgent,
  orchestrateTeamResponse,
  formatAsMarkdownDocument,
  shouldUseTeamOrchestration,
};
