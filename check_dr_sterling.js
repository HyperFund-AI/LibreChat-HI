/**
 * Diagnostic script to check Dr. Sterling agent
 * Run with: node check_dr_sterling.js
 */

require('dotenv').config();
require('module-alias')({ base: __dirname + '/api' });

const mongoose = require('mongoose');

async function checkDrSterling() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
      console.error('❌ MONGO_URI not set in .env');
      return;
    }
    
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');
    
    // Get the Agent model
    const Agent = mongoose.model('Agent', require('./api/models/schema/agent'));
    
    // Find Dr. Sterling
    const drSterling = await Agent.findOne({ id: 'dr_sterling_coordinator' }).lean();
    
    if (!drSterling) {
      console.log('❌ Dr. Sterling agent NOT FOUND in database!');
      console.log('\n📋 All agents in database:');
      const allAgents = await Agent.find({}, { id: 1, name: 1 }).lean();
      allAgents.forEach(a => console.log(`  - ${a.id}: ${a.name}`));
    } else {
      console.log('✅ Dr. Sterling agent FOUND!');
      console.log('\n📋 Agent Details:');
      console.log(`  ID: ${drSterling.id}`);
      console.log(`  Name: ${drSterling.name}`);
      console.log(`  Provider: ${drSterling.provider}`);
      console.log(`  Model: ${drSterling.model}`);
      console.log(`  isTeamCoordinator: ${drSterling.isTeamCoordinator}`);
      console.log(`  Tools: ${JSON.stringify(drSterling.tools || [])}`);
      console.log(`\n📝 Instructions:`);
      if (drSterling.instructions) {
        console.log(`  Length: ${drSterling.instructions.length} characters`);
        console.log(`  Preview: ${drSterling.instructions.substring(0, 300)}...`);
      } else {
        console.log('  ❌ NO INSTRUCTIONS SET!');
      }
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
}

checkDrSterling();

