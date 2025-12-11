// Quick script to check team agent status
const mongoose = require('mongoose');
require('dotenv').config();

async function checkTeamStatus() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/LibreChat');
    console.log('Connected to MongoDB\n');

    const Conversation = mongoose.model('Conversation', new mongoose.Schema({}, { strict: false }));

    // Get most recent conversation
    const recentConvo = await Conversation.findOne().sort({ updatedAt: -1 }).lean();

    if (!recentConvo) {
      console.log('❌ No conversations found');
      return;
    }

    console.log('📋 Most Recent Conversation:');
    console.log(`   ID: ${recentConvo.conversationId}`);
    console.log(`   Endpoint: ${recentConvo.endpoint || 'N/A'}`);
    console.log(`   Updated: ${recentConvo.updatedAt}`);
    console.log(`   Files: ${recentConvo.files?.length || 0}`);

    if (recentConvo.teamAgents && recentConvo.teamAgents.length > 0) {
      console.log(`\n✅ Team Agents Found: ${recentConvo.teamAgents.length}`);
      recentConvo.teamAgents.forEach((agent, i) => {
        console.log(`   ${i + 1}. ${agent.role} (${agent.name})`);
        console.log(`      ID: ${agent.agentId}`);
      });
      console.log(`\n   Host Agent ID: ${recentConvo.hostAgentId || 'N/A'}`);
      console.log(`   Team File ID: ${recentConvo.teamFileId || 'N/A'}`);
    } else {
      console.log('\n❌ No team agents found');
      console.log('\nPossible reasons:');
      console.log('   1. File was not uploaded as message attachment');
      console.log('   2. File type is not PDF/document');
      console.log('   3. Conversation ID was missing during upload');
      console.log('   4. Team creation is still processing (check logs)');
      console.log('   5. Wrong endpoint (must be "agents" endpoint)');
    }

    await mongoose.disconnect();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

checkTeamStatus();
