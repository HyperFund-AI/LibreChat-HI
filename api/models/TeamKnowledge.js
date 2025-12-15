const { logger } = require('@librechat/data-schemas');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

/**
 * Schema for team knowledge base documents
 * Stores approved documents that teams have generated for future reference
 */
const teamKnowledgeSchema = new mongoose.Schema(
  {
    conversationId: {
      type: String,
      required: true,
      index: true,
    },
    documentId: {
      type: String,
      required: true,
      unique: true,
    },
    dedupeKey: {
      type: String,
      default: '',
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    contentType: {
      type: String,
      default: 'markdown',
      enum: ['markdown', 'text', 'json'],
    },
    messageId: {
      type: String,
      required: true,
    },
    createdBy: {
      type: String,
      required: true,
    },
    tags: {
      type: [String],
      default: [],
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

// Compound index for efficient queries
teamKnowledgeSchema.index({ conversationId: 1, createdAt: -1 });

// Dedupe index: only enforced when `dedupeKey` is non-empty
teamKnowledgeSchema.index(
  { conversationId: 1, dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: 'string', $ne: '' } },
  },
);

const TeamKnowledge = mongoose.model('TeamKnowledge', teamKnowledgeSchema);

/**
 * Saves a document to the team knowledge base
 * @param {Object} params - Document parameters
 * @param {string} params.conversationId - The conversation ID
 * @param {string} params.documentId - Unique document ID (optional if `dedupeKey` is provided)
 * @param {string} params.dedupeKey - Optional dedupe key to upsert by (e.g. `${messageId}:${filename}`)
 * @param {string} params.title - Document title
 * @param {string} params.content - Document content (markdown)
 * @param {string} params.messageId - Source message ID
 * @param {string} params.createdBy - User ID who approved
 * @param {string[]} params.tags - Optional tags
 * @param {Object} params.metadata - Optional metadata
 * @returns {Promise<Object>} Created document
 */
const saveToKnowledge = async ({
  conversationId,
  documentId,
  dedupeKey = '',
  title,
  content,
  messageId,
  createdBy,
  tags = [],
  metadata = {},
  onlyUpdate = false,
}) => {
  try {
    // TODO documentId is better but how to keep it stable?
    const normalizedDedupeKey = typeof dedupeKey === 'string' ? dedupeKey.trim() : '';
    const resolvedDocumentId = documentId || `kb_${conversationId}_${uuidv4()}`;

    const filter = normalizedDedupeKey
      ? { conversationId, dedupeKey: normalizedDedupeKey }
      : { documentId: resolvedDocumentId };

    const update = {
      $set: {
        conversationId,
        title,
        content,
        contentType: 'markdown',
        messageId,
        createdBy,
        tags,
        metadata,
        ...(normalizedDedupeKey ? { dedupeKey: normalizedDedupeKey } : {}),
      },
      $setOnInsert: {
        documentId: resolvedDocumentId,
      },
    };

    const doc = await TeamKnowledge.findOneAndUpdate(filter, update, { upsert: true, new: true });

    // Trigger embedding generation (Fire and forget, or await if critical)
    const { upsertDocumentEmbeddings } = require('~/server/utils/vectorUtils');
    // Using await here to ensure data consistency for now, can be made async if too slow
    await upsertDocumentEmbeddings(doc);

    if (!doc && onlyUpdate) {
      return null;
    }

    logger.info(
      `[TeamKnowledge] Saved document "${title}" to knowledge base for conversation ${conversationId}`,
    );
    return doc;
  } catch (error) {
    logger.error('[TeamKnowledge] Error saving to knowledge base:', error);
    throw error;
  }
};

/**
 * Gets all knowledge documents for a conversation
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<Array>} Array of knowledge documents
 */
const getKnowledge = async (conversationId) => {
  try {
    const docs = await TeamKnowledge.find({ conversationId }).sort({ createdAt: -1 }).lean();
    return docs;
  } catch (error) {
    logger.error('[TeamKnowledge] Error getting knowledge:', error);
    return [];
  }
};

/**
 * Gets a specific knowledge document
 * @param {string} documentId - The document ID
 * @returns {Promise<Object|null>} Knowledge document or null
 */
const getKnowledgeDocument = async (documentId) => {
  try {
    return await TeamKnowledge.findOne({ documentId }).lean();
  } catch (error) {
    logger.error('[TeamKnowledge] Error getting document:', error);
    return null;
  }
};

/**
 * Deletes a knowledge document
 * @param {string} documentId - The document ID
 * @returns {Promise<boolean>} Success status
 */
const deleteKnowledgeDocument = async (documentId) => {
  try {
    await TeamKnowledge.deleteOne({ documentId });
    logger.info(`[TeamKnowledge] Deleted document ${documentId}`);
    return true;
  } catch (error) {
    logger.error('[TeamKnowledge] Error deleting document:', error);
    return false;
  }
};

/**
 * Clears all knowledge for a conversation
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<number>} Number of documents deleted
 */
const clearKnowledge = async (conversationId) => {
  try {
    const result = await TeamKnowledge.deleteMany({ conversationId });
    logger.info(
      `[TeamKnowledge] Cleared ${result.deletedCount} documents from conversation ${conversationId}`,
    );
    return result.deletedCount;
  } catch (error) {
    logger.error('[TeamKnowledge] Error clearing knowledge:', error);
    return 0;
  }
};

/**
 * Formats knowledge documents for context injection
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<string>} Formatted knowledge context
 */
const getKnowledgeContext = async (conversationId) => {
  try {
    const docs = await getKnowledge(conversationId);

    if (docs.length === 0) {
      return '';
    }

    const context = docs
      .map((doc, i) => `### Document ${i + 1}: ${doc.title}\n${doc.content}`)
      .join('\n\n---\n\n');

    return `## Team Knowledge Base\nThe following documents have been previously created and approved by the team:\n\n${context}`;
  } catch (error) {
    logger.error('[TeamKnowledge] Error formatting knowledge context:', error);
    return '';
  }
};

/**
 * Searches the knowledge base for relevant chunks
 * @param {string} conversationId
 * @param {string} query
 * @param {number} k
 * @returns {Promise<Array<{text: string, score: number, documentId: string}>>}
 */
const searchKnowledge = async (conversationId, query, k = 5) => {
  try {
    const TeamKnowledgeVector = require('~/models/TeamKnowledgeVector');
    const { getOpenRouterEmbedding } = require('~/server/utils/embeddings');
    const { cosineSimilarity } = require('~/server/utils/vectorUtils');

    // 1. Embed query
    const queryVector = await getOpenRouterEmbedding(query);
    if (!queryVector) return [];

    // 2. Fetch all vectors for conversation
    // Optimization: Depending on scale, we might want to fetch only subset or use a real vector index
    const vectors = await TeamKnowledgeVector.find({ conversationId }).lean();

    if (!vectors.length) return [];

    // 3. Compute scores
    const scored = vectors.map((v) => ({
      text: v.text,
      documentId: v.documentId,
      score: cosineSimilarity(queryVector, v.vector),
    }));

    // 4. Sort and top K
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  } catch (err) {
    logger.error('[TeamKnowledge] Error searching knowledge:', err);
    return [];
  }
};

module.exports = {
  TeamKnowledge,
  saveToKnowledge,
  getKnowledge,
  getKnowledgeDocument,
  deleteKnowledgeDocument,
  clearKnowledge,
  getKnowledgeContext,
  searchKnowledge,
};
