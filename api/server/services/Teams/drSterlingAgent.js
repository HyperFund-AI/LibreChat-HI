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
    // Try pipe-delimited table first - capture until next ## section (not just --- separator)
    let tableMatch = markdownOutput.match(/\| Tier \| Role.*\|[\s\S]*?(?=\n##|$)/i);
    let delimiter = '|';
    
    // If no pipe table found, try tab-delimited table
    if (!tableMatch) {
      tableMatch = markdownOutput.match(/Tier\t+Role[\s\S]*?(?=\n##|$)/i);
      delimiter = '\t';
    }
    
    // Also try to find table after "Team Composition" header - be more flexible
    if (!tableMatch) {
      tableMatch = markdownOutput.match(/##\s*TEAM COMPOSITION[^\n]*\n+([^\n]*Tier[^\n]*\n[\s\S]*?)(?=\n##|$)/i);
      if (tableMatch) {
        delimiter = tableMatch[0].includes('|') ? '|' : '\t';
      }
    }
    
    // Also try "Team Composition Summary" header
    if (!tableMatch) {
      tableMatch = markdownOutput.match(/Team Composition Summary[^\n]*\n+([^\n]*Tier[^\n]*\n[\s\S]*?)(?=\n##|$)/i);
      if (tableMatch) {
        delimiter = tableMatch[0].includes('|') ? '|' : '\t';
      }
    }
    
    // Fallback: try generic "Team Composition" without ##
    if (!tableMatch) {
      tableMatch = markdownOutput.match(/Team Composition[^\n]*\n+([^\n]*Tier[^\n]*\n[\s\S]*?)(?=\n##|$)/i);
      if (tableMatch) {
        delimiter = tableMatch[0].includes('|') ? '|' : '\t';
      }
    }
    
    if (tableMatch) {
      logger.info(`[parseTeamFromMarkdown] Found table with delimiter: "${delimiter === '\t' ? 'TAB' : 'PIPE'}"`);
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
      logger.info(`[parseTeamFromMarkdown] Processing ${dataLines.length} data rows from table`);
      
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
      logger.info(`[parseTeamFromMarkdown] Added ${team.members.length} members from table`);
    } else {
      logger.debug('[parseTeamFromMarkdown] No table found in markdown');
    }

    // Extract detailed specifications - ONLY update existing members, don't add new ones
    const specSection = markdownOutput.match(/## SUPERHUMAN SPECIFICATIONS([\s\S]*?)(?=##\s*PROJECT INTEGRATION|##\s*COLLABORATION|##\s*ORCHESTRATION|$)/i);
    if (specSection) {
      const specContent = specSection[1];
      
      // Find all member blocks by looking for ### followed by what looks like a person's name
      // We need to split on ### headers that are person names, not subsection headers
      // Subsection headers are things like "Professional Foundation", "Expertise Architecture", etc.
      // Person names typically don't have colons or are followed by blank lines and then "Role:"
      
      // First, find all potential member headers (### followed by text that might be a name)
      const memberHeaderPattern = /###\s+([^\n]+)/g;
      const memberHeaders = [];
      let match;
      
      while ((match = memberHeaderPattern.exec(specContent)) !== null) {
        const potentialName = match[1].trim();
        // Check if this looks like a person's name (not a subsection header)
        // Subsection headers are usually things like "Professional Foundation", "Expertise Architecture"
        // Person names are usually just names, possibly with parenthetical role
        const nameOnly = potentialName.replace(/\s*\([^)]+\)\s*$/, '').trim();
        
        if (looksLikePersonName(nameOnly)) {
          memberHeaders.push({
            index: match.index,
            name: nameOnly,
            rawName: potentialName,
            fullMatch: match[0],
          });
        }
      }
      
      logger.info(`[parseTeamFromMarkdown] Found ${memberHeaders.length} member headers in specifications section`);
      
      // Extract blocks for each member (from their header to the next member header or end)
      let updatedCount = 0;
      let addedCount = 0;
      
      for (let i = 0; i < memberHeaders.length; i++) {
        const header = memberHeaders[i];
        const startIndex = header.index + header.fullMatch.length;
        const endIndex = i < memberHeaders.length - 1 
          ? memberHeaders[i + 1].index 
          : specContent.length;
        
        const block = specContent.substring(startIndex, endIndex).trim();
        const nameOnly = header.name;
        
        // Try to find existing member by name (fuzzy match)
        const existingMember = team.members.find(m => 
          m.name === nameOnly || 
          m.name.toLowerCase() === nameOnly.toLowerCase() ||
          m.name.includes(nameOnly) ||
          nameOnly.includes(m.name)
        );
        
        // Extract role from the block (should be near the top)
        const roleMatch = block.match(/\*\*Role:\*\*\s*([^\n]+)/i);
        
        // Extract expertise
        const expertiseMatch = block.match(/\*\*Expertise:\*\*\s*([^\n]+)/i);
        
        // The full block IS the instructions (includes everything: role, expertise, all sections)
        // Prepend the name header to make it complete
        const fullInstructions = `### ${header.rawName}\n\n${block}`.trim();
        
        if (existingMember) {
          // Update existing member with detailed instructions
          existingMember.instructions = fullInstructions;
          if (roleMatch) existingMember.detailedRole = roleMatch[1].trim();
          if (expertiseMatch) existingMember.expertise = expertiseMatch[1].trim();
          updatedCount++;
          logger.debug(`[parseTeamFromMarkdown] Updated member: ${existingMember.name} (${fullInstructions.length} chars)`);
        } else {
          // Add new member even if not in table - specifications section is authoritative
          // The table might be incomplete or the member might be new
          team.members.push({
            name: nameOnly,
            role: roleMatch ? roleMatch[1].trim() : nameOnly,
            expertise: expertiseMatch ? expertiseMatch[1].trim() : '',
            instructions: fullInstructions,
            // Try to extract tier from the block if available
            tier: block.match(/\*\*Classification:\*\*[^\n]*Tier\s+(\d+)/i)?.[1] || null,
            behavioralLevel: block.match(/\*\*Behavioral Science Level:\*\*\s*([^\n]+)/i)?.[1]?.trim() || 'NONE',
          });
          addedCount++;
          logger.debug(`[parseTeamFromMarkdown] Added member from specs: ${nameOnly} (${fullInstructions.length} chars)`);
        }
      }
      
      logger.info(`[parseTeamFromMarkdown] Specifications: Updated ${updatedCount} members, Added ${addedCount} new members`);
    }

    logger.info(`[parseTeamFromMarkdown] Parsed ${team.members.length} team members`);
    return team.members.length > 0 ? team : null;
  } catch (error) {
    logger.error('[parseTeamFromMarkdown] Error parsing team:', error);
    return null;
  }
};

/**
 * Checks if a message contains team specification content
 * @param {string} msgText - The message text to check
 * @returns {boolean} True if message contains team spec patterns
 */
const isTeamRelatedMessage = (msgText) => {
  if (!msgText || msgText.length < 100) return false;
  
  const teamSpecPatterns = [
    '# SUPERHUMAN TEAM:',
    '## SUPERHUMAN SPECIFICATIONS',
    'SUPERHUMAN TEAM:',
    '## TEAM COMPOSITION',
    '### Team Member',
    '| Tier | Role',
    'Tier\t+Role',
  ];
  
  return teamSpecPatterns.some(pattern => msgText.includes(pattern));
};

/**
 * Merges team members from multiple parsed teams, using the latest information for each member
 * @param {Array<Object>} parsedTeams - Array of parsed team objects
 * @returns {Object} Merged team with aggregated members
 */
const mergeTeamMembers = (parsedTeams) => {
  const mergedTeam = {
    projectName: '',
    complexity: '',
    teamSize: 0,
    members: [],
  };
  
  // Use a Map to track members by name (case-insensitive)
  const membersMap = new Map();
  
  // Process teams in order (oldest to newest) so later ones override earlier ones
  for (const team of parsedTeams) {
    // Update metadata from latest team
    if (team.projectName) mergedTeam.projectName = team.projectName;
    if (team.complexity) mergedTeam.complexity = team.complexity;
    if (team.teamSize > 0) mergedTeam.teamSize = team.teamSize;
    
    // Merge members
    for (const member of team.members || []) {
      const nameKey = member.name.toLowerCase().trim();
      
      if (membersMap.has(nameKey)) {
        // Update existing member with latest information
        const existing = membersMap.get(nameKey);
        
        // Merge fields, preferring non-empty values from the new member
        existing.tier = member.tier || existing.tier;
        existing.role = member.role || existing.role;
        existing.expertise = member.expertise || existing.expertise;
        existing.behavioralLevel = member.behavioralLevel || existing.behavioralLevel;
        existing.detailedRole = member.detailedRole || existing.detailedRole;
        
        // Instructions: prefer longer/more detailed instructions
        if (member.instructions) {
          if (!existing.instructions || member.instructions.length > existing.instructions.length) {
            existing.instructions = member.instructions;
          }
        }
        
        logger.debug(`[mergeTeamMembers] Updated member: ${member.name}`);
      } else {
        // Add new member
        membersMap.set(nameKey, { ...member });
        logger.debug(`[mergeTeamMembers] Added new member: ${member.name}`);
      }
    }
  }
  
  // Convert map values to array
  mergedTeam.members = Array.from(membersMap.values());
  
  logger.info(`[mergeTeamMembers] Merged ${parsedTeams.length} team specs into ${mergedTeam.members.length} unique members`);
  return mergedTeam;
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
    
    // Use full instructions if available, otherwise create a basic one
    const instructions = member.instructions || `You are ${member.name}, a ${member.role}. ${member.expertise || ''}`;
    
    logger.debug(`[convertParsedTeamToAgents] Converting ${member.name}: instructions length = ${instructions.length} chars`);
    
    return {
      agentId: `team_${conversationId}_${roleSlug}_${timestamp}_${index}`,
      role: member.role || member.name,
      name: member.name,
      instructions: instructions,
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
  isTeamRelatedMessage,
  mergeTeamMembers,
  DR_STERLING_AGENT_ID,
  DEFAULT_ANTHROPIC_MODEL,
};

