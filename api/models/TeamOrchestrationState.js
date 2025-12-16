const mongoose = require('mongoose');

const specialistStateSchema = new mongoose.Schema({
  agentName: String,
  status: {
    type: String,
    enum: ['PENDING', 'WORKING', 'COMPLETED', 'PAUSED'],
    default: 'PENDING',
  },
  messages: Array, // Full ReAct history (user query + tool calls + assistant responses)
  currentOutput: String, // Partial or final output
  interruptQuestion: String, // If paused, this is the question asked to the user
});

const teamOrchestrationSchema = new mongoose.Schema({
  conversationId: { type: String, required: true, index: true },
  parentMessageId: { type: String, required: true }, // The user message that started this orchestration
  status: {
    type: String,
    enum: ['IN_PROGRESS', 'PAUSED', 'COMPLETED', 'FAILED'],
    default: 'IN_PROGRESS',
  },
  leadPlan: Object, // The initial plan from the lead agent
  specialistStates: [specialistStateSchema], // Array of states for each specialist
  sharedContext: String, // Context built up during execution
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

teamOrchestrationSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

const TeamOrchestrationState = mongoose.model('TeamOrchestrationState', teamOrchestrationSchema);

const saveOrchestrationState = async (data) => {
  try {
    const { conversationId } = data;
    // Upsert state
    return await TeamOrchestrationState.findOneAndUpdate({ conversationId }, data, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });
  } catch (err) {
    console.error('[TeamOrchestrationState] Error saving state:', err);
    throw err;
  }
};

const getOrchestrationState = async (conversationId) => {
  try {
    return await TeamOrchestrationState.findOne({ conversationId });
  } catch (err) {
    console.error('[TeamOrchestrationState] Error getting state:', err);
    return null;
  }
};

const clearOrchestrationState = async (conversationId) => {
  try {
    return await TeamOrchestrationState.deleteOne({ conversationId });
  } catch (err) {
    console.error('[TeamOrchestrationState] Error clearing state:', err);
    throw err;
  }
};

module.exports = {
  TeamOrchestrationState,
  saveOrchestrationState,
  getOrchestrationState,
  clearOrchestrationState,
};
