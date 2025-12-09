const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth, setHeaders } = require('~/server/middleware');
const {
  getDrSterlingAgent,
  parseTeamFromMarkdown,
  convertParsedTeamToAgents,
  DR_STERLING_AGENT_ID,
} = require('~/server/services/Teams');
const { saveTeamAgents, getTeamAgents, getTeamInfo, clearTeamAgents } = require('~/models/Conversation');
const { teamChatController } = require('~/server/controllers/teams');

const router = express.Router();

// All routes require authentication
router.use(requireJwtAuth);

/**
 * GET /api/teams/dr-sterling
 * Get or create Dr. Sterling agent for the user
 */
router.get('/dr-sterling', async (req, res) => {
  try {
    const drSterling = await getDrSterlingAgent(req.user.id);
    res.json({
      success: true,
      agent: {
        id: drSterling.id,
        name: drSterling.name,
        description: drSterling.description,
        avatar: drSterling.avatar,
      },
    });
  } catch (error) {
    logger.error('[GET /api/teams/dr-sterling] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/teams/:conversationId
 * Get team info including agents and objective for a conversation
 */
router.get('/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const teamInfo = await getTeamInfo(conversationId);
    
    res.json({
      success: true,
      conversationId,
      teamAgents: teamInfo?.teamAgents || [],
      teamObjective: teamInfo?.teamObjective || null,
      hostAgentId: teamInfo?.hostAgentId || null,
      count: teamInfo?.teamAgents?.length || 0,
    });
  } catch (error) {
    logger.error('[GET /api/teams/:conversationId] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/teams/:conversationId/parse
 * Parse team from Dr. Sterling's markdown output and save to conversation
 * Also saves the team objective for later execution
 */
router.post('/:conversationId/parse', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { markdownContent, objective } = req.body;

    if (!markdownContent) {
      return res.status(400).json({ 
        success: false, 
        error: 'markdownContent is required' 
      });
    }

    // Parse the team from markdown
    const parsedTeam = parseTeamFromMarkdown(markdownContent);
    
    if (!parsedTeam || parsedTeam.members.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Could not parse team from markdown. Make sure Dr. Sterling has generated a complete team specification.',
      });
    }

    // Try to extract objective from markdown if not explicitly provided
    let teamObjective = objective || null;
    
    if (!teamObjective) {
      // Look for objective in markdown (common patterns from Dr. Sterling)
      const objectivePatterns = [
        /\*\*Project Objective:\*\*\s*([^\n]+)/i,
        /\*\*Objective:\*\*\s*([^\n]+)/i,
        /\*\*Primary Objective:\*\*\s*([^\n]+)/i,
        /## PROJECT OVERVIEW[\s\S]*?(?:objective|goal|mission)[:\s]+([^\n]+)/i,
      ];
      
      for (const pattern of objectivePatterns) {
        const match = markdownContent.match(pattern);
        if (match) {
          teamObjective = match[1].trim();
          break;
        }
      }
    }

    // Convert to agent format
    const teamAgents = convertParsedTeamToAgents(parsedTeam, conversationId);

    // Save to conversation with objective
    await saveTeamAgents(conversationId, teamAgents, DR_STERLING_AGENT_ID, null, teamObjective);

    logger.info(`[POST /api/teams/:conversationId/parse] Created ${teamAgents.length} team agents${teamObjective ? ' with objective' : ''}`);

    res.json({
      success: true,
      projectName: parsedTeam.projectName,
      complexity: parsedTeam.complexity,
      teamSize: parsedTeam.teamSize,
      teamObjective,
      teamAgents,
    });
  } catch (error) {
    logger.error('[POST /api/teams/:conversationId/parse] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/teams/:conversationId
 * Clear team agents from a conversation
 */
router.delete('/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    await clearTeamAgents(conversationId);
    
    res.json({
      success: true,
      message: 'Team agents cleared successfully',
    });
  } catch (error) {
    logger.error('[DELETE /api/teams/:conversationId] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/teams/:conversationId/chat
 * Send a message to the team and get collaborative response
 */
router.post('/:conversationId/chat', setHeaders, async (req, res) => {
  try {
    // Add conversationId from params to body for the controller
    req.body.conversationId = req.params.conversationId;
    await teamChatController(req, res);
  } catch (error) {
    logger.error('[POST /api/teams/:conversationId/chat] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

module.exports = router;

