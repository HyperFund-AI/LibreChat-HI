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
 * Checks if a string looks like a person's name (has at least first and last name)
 * @param {string} str - String to check
 * @returns {boolean}
 */
const looksLikePersonName = (str) => {
  if (!str || typeof str !== 'string') return false;
  
  // Remove common prefixes like "Dr.", "Mr.", "Ms.", etc.
  const cleanName = str.replace(/^(Dr\.|Mr\.|Ms\.|Mrs\.|Prof\.)\s*/i, '').trim();
  
  // Should have at least 2 words (first and last name)
  const words = cleanName.split(/\s+/).filter(w => w.length > 1);
  if (words.length < 2) return false;
  
  // Should not be generic section headers
  const genericHeaders = [
    'professional foundation', 'expertise architecture', 'operational parameters',
    'excellence framework', 'quality assurance', 'project integration',
    'team composition', 'behavioral science', 'domain specialist',
    'collaboration protocol', 'success metrics', 'deliverables',
  ];
  if (genericHeaders.some(h => cleanName.toLowerCase().includes(h))) return false;
  
  // First word should start with uppercase (typical for names)
  if (!/^[A-Z]/.test(words[0])) return false;
  
  return true;
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

    // Extract team members from the composition table (supports both pipe and tab delimiters)
    // Try pipe-delimited table first
    let tableMatch = markdownOutput.match(/\| Tier \| Role.*\|[\s\S]*?(?=\n---|\n##|$)/i);
    let delimiter = '|';
    
    // If no pipe table found, try tab-delimited table
    if (!tableMatch) {
      tableMatch = markdownOutput.match(/Tier\t+Role[\s\S]*?(?=\n\n|\n##|$)/i);
      delimiter = '\t';
    }
    
    // Also try to find table after "Team Composition" header
    if (!tableMatch) {
      tableMatch = markdownOutput.match(/Team Composition[^\n]*\n+([^\n]*Tier[^\n]*\n[\s\S]*?)(?=\n\n\n|\n##|$)/i);
      delimiter = tableMatch && tableMatch[0].includes('|') ? '|' : '\t';
    }
    
    if (tableMatch) {
      logger.debug(`[parseTeamFromMarkdown] Found table with delimiter: "${delimiter === '\t' ? 'TAB' : 'PIPE'}"`);
      const tableContent = tableMatch[0];
      const tableLines = tableContent.split('\n').filter(line => {
        const trimmed = line.trim();
        // Skip empty lines, separator lines (---), and header-only lines
        return trimmed.length > 0 && 
               !trimmed.match(/^[-|:\s]+$/) && // Skip separator lines like |---|---|
               !trimmed.match(/^-+$/); // Skip --- lines
      });
      
      logger.debug(`[parseTeamFromMarkdown] Table lines: ${tableLines.length}`);
      
      // Find header row to determine column positions
      const headerIndex = tableLines.findIndex(line => 
        line.toLowerCase().includes('tier') && 
        (line.toLowerCase().includes('role') || line.toLowerCase().includes('name'))
      );
      
      // Process data rows (skip header)
      const dataLines = headerIndex >= 0 ? tableLines.slice(headerIndex + 1) : tableLines.slice(1);
      
      for (const line of dataLines) {
        // Split by delimiter (pipe or tab)
        const cells = delimiter === '|' 
          ? line.split('|').map(cell => cell.trim()).filter(Boolean)
          : line.split(/\t+/).map(cell => cell.trim()).filter(Boolean);
        
        logger.debug(`[parseTeamFromMarkdown] Row cells: ${JSON.stringify(cells)}`);
        
        if (cells.length >= 3) {
          // Try to identify name column (usually contains a person's name)
          // Format could be: Tier | Role | Name | Expertise | Behavioral
          // Or: Tier | Role | Name | Expertise
          let tier = cells[0];
          let role = cells[1];
          let name = cells[2];
          let expertise = cells[3] || '';
          let behavioralLevel = cells[4] || 'NONE';
          
          // Skip if first cell doesn't look like a tier number
          if (!/^\d+$/.test(tier.trim())) {
            logger.debug(`[parseTeamFromMarkdown] Skipping row - tier "${tier}" is not a number`);
            continue;
          }
          
          // Only add if name looks like a person's name
          if (looksLikePersonName(name)) {
            team.members.push({
              tier: tier,
              role: role,
              name: name,
              expertise: expertise,
              behavioralLevel: behavioralLevel,
            });
            logger.debug(`[parseTeamFromMarkdown] Added from table: ${name} (${role})`);
          } else {
            logger.debug(`[parseTeamFromMarkdown] Skipping - "${name}" doesn't look like a name`);
          }
        }
      }
    } else {
      logger.debug('[parseTeamFromMarkdown] No table found in markdown');
    }

    // Extract detailed specifications - ONLY update existing members, don't add new ones
    const specSection = markdownOutput.match(/## SUPERHUMAN SPECIFICATIONS([\s\S]*?)(?=##\s*PROJECT INTEGRATION|##\s*COLLABORATION|$)/i);
    if (specSection) {
      const specContent = specSection[1];
      
      // Parse individual superhuman blocks
      const superhumanBlocks = specContent.split(/###\s+/).filter(Boolean);
      
      for (const block of superhumanBlocks) {
        const nameMatch = block.match(/^([^\n]+)/);
        if (!nameMatch) continue;
        
        // Extract just the name part (before any parenthetical role description)
        let rawName = nameMatch[1].trim();
        // Handle "Name (Role)" format
        const nameOnly = rawName.replace(/\s*\([^)]+\)\s*$/, '').trim();
        
        // Skip if it doesn't look like a person's name
        if (!looksLikePersonName(nameOnly)) {
          logger.debug(`[parseTeamFromMarkdown] Skipping non-person entry: "${rawName}"`);
          continue;
        }
        
        // Try to find existing member by name (fuzzy match)
        const existingMember = team.members.find(m => 
          m.name === nameOnly || 
          m.name.toLowerCase() === nameOnly.toLowerCase() ||
          m.name.includes(nameOnly) ||
          nameOnly.includes(m.name)
        );
        
        // Extract role from the block
        const roleMatch = block.match(/\*\*Role:\*\*\s*([^\n]+)/i);
        
        // Extract expertise
        const expertiseMatch = block.match(/\*\*Expertise:\*\*\s*([^\n]+)/i);
        
        // Extract the full block as instructions
        const instructions = block.substring(nameMatch[0].length).trim();
        
        if (existingMember) {
          // Update existing member with detailed instructions
          existingMember.instructions = instructions;
          if (roleMatch) existingMember.detailedRole = roleMatch[1].trim();
          if (expertiseMatch) existingMember.expertise = expertiseMatch[1].trim();
          logger.debug(`[parseTeamFromMarkdown] Updated member: ${existingMember.name}`);
        } else if (team.members.length === 0) {
          // Only add new members if we didn't get any from the table
          team.members.push({
            name: nameOnly,
            role: roleMatch ? roleMatch[1].trim() : nameOnly,
            expertise: expertiseMatch ? expertiseMatch[1].trim() : '',
            instructions,
          });
          logger.debug(`[parseTeamFromMarkdown] Added member (no table): ${nameOnly}`);
        } else {
          logger.debug(`[parseTeamFromMarkdown] Skipping unmatched entry: "${nameOnly}" (not in table)`);
        }
      }
    }

    logger.info(`[parseTeamFromMarkdown] Parsed ${team.members.length} team members`);
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

