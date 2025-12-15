const mongoose = require('mongoose');

const teamKnowledgeVectorSchema = new mongoose.Schema({
    documentId: {
        type: String,
        required: true,
        index: true,
    },
    conversationId: {
        type: String,
        required: true,
        index: true,
    },
    chunkIndex: {
        type: Number,
        required: true,
    },
    text: {
        type: String,
        required: true,
    },
    vector: {
        type: [Number],
        required: true,
    },
}, { timestamps: true });

// Compound index for efficient retrieval during search
teamKnowledgeVectorSchema.index({ conversationId: 1, documentId: 1 });

const TeamKnowledgeVector = mongoose.model('TeamKnowledgeVector', teamKnowledgeVectorSchema);

module.exports = TeamKnowledgeVector;
