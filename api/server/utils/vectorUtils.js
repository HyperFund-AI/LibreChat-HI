const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');
const { getOpenRouterEmbedding } = require('./embeddings');
const { logger } = require('@librechat/data-schemas');
const TeamKnowledgeVector = require('~/models/TeamKnowledgeVector');

/**
 * Split text into chunks
 * @param {string} text
 * @returns {Promise<string[]>}
 */
const chunkText = async (text) => {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  return await splitter.splitText(text);
};

/**
 * Split text into chunks with metadata
 * @param {string} text
 * @returns {Promise<Object[]>}
 */
const chunkTextWithMetadata = async (text) => {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  return await splitter.createDocuments([text]);
};

/**
 * Calculate cosine similarity between two vectors
 * @param {number[]} vecA
 * @param {number[]} vecB
 * @returns {number}
 */
const cosineSimilarity = (vecA, vecB) => {
  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    magnitudeA += vecA[i] * vecA[i];
    magnitudeB += vecB[i] * vecB[i];
  }
  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);
  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }
  return dotProduct / (magnitudeA * magnitudeB);
};

/**
 * Generate embeddings for document chunks and store them in the database.
 * Deletes old vectors for the document before inserting new ones.
 * @param {Object} document - The TeamKnowledge document
 */
const upsertDocumentEmbeddings = async (document) => {
  try {
    const { documentId, conversationId, content } = document;
    if (!content) return;

    // 1. Chunk the content with metadata
    const docs = await chunkTextWithMetadata(content);

    // 2. Generate embeddings for all chunks
    // Note: getOpenRouterEmbedding generates for a single string.
    // We should probably parallelize this or use a batch API if available,
    // but the current helper is single-input. Let's map it.
    const vectorsData = await Promise.all(
      docs.map(async (doc, index) => {
        const text = doc.pageContent;
        const vector = await getOpenRouterEmbedding(text);
        return {
          documentId,
          conversationId,
          chunkIndex: index,
          text,
          vector,
          metadata: doc.metadata || {},
        };
      }),
    );

    // 3. Delete old vectors
    await TeamKnowledgeVector.deleteMany({ documentId });

    // 4. Insert new vectors
    if (vectorsData.length > 0) {
      await TeamKnowledgeVector.insertMany(vectorsData);
    }

    logger.info(`[VectorUtils] Upserted ${vectorsData.length} vectors for document ${documentId}`);
  } catch (err) {
    logger.error(`[VectorUtils] Error upserting embeddings for ${document.documentId}:`, err);
    // We do not throw here to avoid blocking the main save flow if embedding fails
  }
};

module.exports = {
  chunkText,
  chunkTextWithMetadata,
  cosineSimilarity,
  upsertDocumentEmbeddings,
};
