const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint } = require('librechat-data-provider');
const { createAgent, getAgent, updateAgent } = require('~/models/Agent');
const { COORDINATOR_SYSTEM_PROMPT } = require('./prompts');

const DR_STERLING_AGENT_ID = 'dr_sterling_coordinator';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

/**
 * Dr. Sterling Agent Configuration
 * A sophisticated interactive coordinator that guides users through team building
 */
const DR_STERLING_CONFIG = {
  id: DR_STERLING_AGENT_ID,
  name: 'Dr. Alexandra Sterling',
  description: `Universal Project Coordinator and Strategic AI Orchestration Director. 
I help you build "Superhuman Teams" of top 0.1% experts for any project. 
Upload your document and I'll guide you through a discovery process to design the perfect team.`,
  instructions: COORDINATOR_SYSTEM_PROMPT,
  provider: EModelEndpoint.anthropic,
  model: DEFAULT_ANTHROPIC_MODEL,
  model_parameters: {
    model: DEFAULT_ANTHROPIC_MODEL,
    // Note: temperature is not set because it's incompatible with Anthropic's thinking mode
    max_tokens: 8192,
  },
  avatar: {
    type: 'icon',
    value: '👩‍💼',
  },
  isTeamCoordinator: true,
  isPublic: true, // Make available to all users
  tools: [],
};

/**
 * Gets or creates the Dr. Sterling coordinator agent
 * @param {string} userId - The user ID (for author field)
 * @returns {Promise<Object>} The Dr. Sterling agent
 */
const getDrSterlingAgent = async (userId) => {
  try {
    // Try to find existing Dr. Sterling agent
    let drSterling = await getAgent({ id: DR_STERLING_AGENT_ID });
    
    if (!drSterling) {
      logger.info('[getDrSterlingAgent] Creating Dr. Sterling agent');
      
      drSterling = await createAgent({
        ...DR_STERLING_CONFIG,
        author: userId,
      });
      
      logger.info('[getDrSterlingAgent] Dr. Sterling agent created successfully');
    } else {
      // Update agent if instructions or model_parameters have changed
      const needsUpdate = 
        drSterling.instructions !== COORDINATOR_SYSTEM_PROMPT ||
        drSterling.model_parameters?.temperature !== undefined; // Remove temperature if present
      
      if (needsUpdate) {
        logger.info('[getDrSterlingAgent] Updating Dr. Sterling configuration');
        drSterling = await updateAgent(
          { id: DR_STERLING_AGENT_ID },
          { 
            instructions: COORDINATOR_SYSTEM_PROMPT,
            model_parameters: DR_STERLING_CONFIG.model_parameters,
          }
        );
      }
    }
    
    return drSterling;
  } catch (error) {
    logger.error('[getDrSterlingAgent] Error:', error);
    throw error;
  }
};

/**
 * Checks if an agent is Dr. Sterling
 * @param {string} agentId - The agent ID to check
 * @returns {boolean}
 */
const isDrSterlingAgent = (agentId) => {
  return agentId === DR_STERLING_AGENT_ID;
};

/**
 * Parses a team specification from Dr. Sterling's markdown output
 * Extracts team members from the SUPERHUMAN SPECIFICATIONS section
 * @param {string} markdownOutput - The markdown document from Dr. Sterling
 * @returns {Object|null} Parsed team structure or null if parsing fails
 */
const parseTeamFromMarkdown = (markdownOutput) => {
  try {
    const team = {
      projectName: '',
      complexity: '',
      teamSize: 0,
      members: [],
    };

    // Extract project name
    const projectMatch = markdownOutput.match(/# SUPERHUMAN TEAM:\s*(.+)/i);
    if (projectMatch) {
      team.projectName = projectMatch[1].trim();
    }

    // Extract complexity
    const complexityMatch = markdownOutput.match(/\*\*Complexity Level:\*\*\s*(\w+)/i);
    if (complexityMatch) {
      team.complexity = complexityMatch[1].trim();
    }

    // Extract team size
    const sizeMatch = markdownOutput.match(/\*\*Team Size:\*\*\s*(\d+)/i);
    if (sizeMatch) {
      team.teamSize = parseInt(sizeMatch[1], 10);
    }

    // Extract team members from the composition table
    const tableMatch = markdownOutput.match(/\| Tier \| Role.*\|[\s\S]*?(?=\n---|\n##|$)/i);
    if (tableMatch) {
      const tableLines = tableMatch[0].split('\n').filter(line => line.includes('|') && !line.includes('---'));
      
      for (const line of tableLines.slice(2)) { // Skip header rows
        const cells = line.split('|').map(cell => cell.trim()).filter(Boolean);
        if (cells.length >= 4) {
          team.members.push({
            tier: cells[0],
            role: cells[1],
            name: cells[2],
            expertise: cells[3],
            behavioralLevel: cells[4] || 'NONE',
          });
        }
      }
    }

    // Extract detailed specifications
    const specSection = markdownOutput.match(/## SUPERHUMAN SPECIFICATIONS([\s\S]*?)(?=##\s*PROJECT INTEGRATION|$)/i);
    if (specSection) {
      const specContent = specSection[1];
      
      // Parse individual superhuman blocks
      const superhumanBlocks = specContent.split(/###\s+/).filter(Boolean);
      
      for (const block of superhumanBlocks) {
        const nameMatch = block.match(/^([^\n]+)/);
        if (!nameMatch) continue;
        
        const name = nameMatch[1].trim();
        const existingMember = team.members.find(m => m.name === name);
        
        // Extract role
        const roleMatch = block.match(/\*\*Role:\*\*\s*([^\n]+)/i);
        
        // Extract expertise
        const expertiseMatch = block.match(/\*\*Expertise:\*\*\s*([^\n]+)/i);
        
        // Extract the full block as instructions
        const instructions = block.substring(nameMatch[0].length).trim();
        
        if (existingMember) {
          existingMember.instructions = instructions;
          if (roleMatch) existingMember.detailedRole = roleMatch[1].trim();
          if (expertiseMatch) existingMember.expertise = expertiseMatch[1].trim();
        } else {
          team.members.push({
            name,
            role: roleMatch ? roleMatch[1].trim() : name,
            expertise: expertiseMatch ? expertiseMatch[1].trim() : '',
            instructions,
          });
        }
      }
    }

    return team.members.length > 0 ? team : null;
  } catch (error) {
    logger.error('[parseTeamFromMarkdown] Error parsing team:', error);
    return null;
  }
};

/**
 * Converts parsed team to the format expected by createTeamAgents
 * @param {Object} parsedTeam - Team parsed from markdown
 * @param {string} conversationId - The conversation ID
 * @returns {Array} Array of team agent configurations
 */
const convertParsedTeamToAgents = (parsedTeam, conversationId) => {
  const timestamp = Date.now();
  
  return parsedTeam.members.map((member, index) => {
    const roleSlug = (member.role || member.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .substring(0, 30);
    
    return {
      agentId: `team_${conversationId}_${roleSlug}_${timestamp}_${index}`,
      role: member.role || member.name,
      name: member.name,
      instructions: member.instructions || `You are ${member.name}, a ${member.role}. ${member.expertise || ''}`,
      provider: EModelEndpoint.anthropic,
      model: DEFAULT_ANTHROPIC_MODEL,
      responsibilities: member.expertise || '',
      tier: member.tier || '4',
      behavioralLevel: member.behavioralLevel || 'NONE',
    };
  });
};

module.exports = {
  getDrSterlingAgent,
  isDrSterlingAgent,
  parseTeamFromMarkdown,
  convertParsedTeamToAgents,
  DR_STERLING_AGENT_ID,
  DEFAULT_ANTHROPIC_MODEL,
};

