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
  thinking: String, // Persisted reasoning/thought process
  interruptQuestion: String, // If paused, this is the question asked to the user
  agentDefinition: Object, // Verification: Full agent definition to ensure robust resume
});

const teamOrchestrationSchema = new mongoose.Schema({
  conversationId: { type: String, required: true, index: true },
  parentMessageId: { type: String, required: true }, // The user message that started this orchestration
  pausedMessageId: { type: String }, // The assistant message (question) where it paused
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

teamOrchestrationSchema.index({ conversationId: 1, parentMessageId: 1 }); // Compound index for branching support

const TeamOrchestrationState = mongoose.model('TeamOrchestrationState', teamOrchestrationSchema);

const saveOrchestrationState = async (data) => {
  try {
    const { conversationId, parentMessageId } = data;
    // Upsert state keyed by conversation AND parent message (branch)
    return await TeamOrchestrationState.findOneAndUpdate(
      { conversationId, parentMessageId },
      data,
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      },
    );
  } catch (err) {
    console.error('[TeamOrchestrationState] Error saving state:', err);
    throw err;
  }
};

const getOrchestrationState = async (conversationId) => {
  try {
    // Return the most recent active state?
    // With branching, this is ambiguous.
    // However, for backward compatibility or simple checks, we might return the latest.
    return await TeamOrchestrationState.findOne({ conversationId }).sort({ updatedAt: -1 });
  } catch (err) {
    console.error('[TeamOrchestrationState] Error getting state:', err);
    return null;
  }
};

/**
 * Finds a paused state where the pausedMessageId matches the given parentId.
 * This indicates a reply to the specific pause question.
 */
const findPausedState = async (conversationId, parentMessageId) => {
  try {
    return await TeamOrchestrationState.findOne({
      conversationId,
      pausedMessageId: parentMessageId,
      status: 'PAUSED',
    });
  } catch (err) {
    console.error('[TeamOrchestrationState] Error finding paused state:', err);
    return null;
  }
};

const clearOrchestrationState = async (conversationId, parentMessageId) => {
  try {
    const query = { conversationId };
    if (parentMessageId) {
      query.parentMessageId = parentMessageId;
    }
    return await TeamOrchestrationState.deleteMany(query);
  } catch (err) {
    console.error('[TeamOrchestrationState] Error clearing state:', err);
    throw err;
  }
};

module.exports = {
  TeamOrchestrationState,
  saveOrchestrationState,
  getOrchestrationState,
  findPausedState,
  clearOrchestrationState,
};
