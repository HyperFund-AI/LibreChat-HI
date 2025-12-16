const { z } = require('zod');
const { betaZodTool } = require('@anthropic-ai/sdk/helpers/beta/zod');
const { getKnowledgeDocument } = require('~/models/TeamKnowledge');

const readKnowledgeDocumentTool = {
  ...betaZodTool({
    name: 'read_knowledge_document',
    description:
      'Reads the content of a document from the Team Knowledge Base. You can specify line ranges to read only a portion of the document.',
    inputSchema: z.object({
      document_id: z
        .string()
        .describe('The unique ID of the document to read (e.g., from search results).'),
      start_line: z
        .number()
        .int()
        .optional()
        .describe('Optional: The starting line number (1-based) to read from.'),
      end_line: z
        .number()
        .int()
        .optional()
        .describe('Optional: The ending line number (1-based) to read to.'),
    }),
    run: async ({ document_id, start_line, end_line }) => {
      try {
        const doc = await getKnowledgeDocument(document_id);
        if (!doc) {
          return `Error: Document with ID ${document_id} not found.`;
        }

        const content = doc.content;
        if (!content) {
          return `Error: Document has no content.`;
        }

        // If no valid line range provided, return full content
        if (start_line === undefined && end_line === undefined) {
          return `### Document: ${doc.title} (ID: ${doc.documentId})\n\n${content}`;
        }

        // Split by newlines for line processing
        const lines = content.split('\n');

        const start = start_line && start_line > 0 ? start_line - 1 : 0;
        const end = end_line && end_line > 0 ? end_line : lines.length;

        // Validate range
        if (start >= lines.length) {
          return `Error: Start line ${start_line} is beyond document length (${lines.length} lines).`;
        }

        const selectedLines = lines.slice(start, end);
        const finalContent = selectedLines.join('\n');
        const rangeInfo = ` (Lines ${start + 1}-${Math.min(end, lines.length)})`;

        return `### Document: ${doc.title} (ID: ${doc.documentId})${rangeInfo}\n\n${finalContent}`;
      } catch (error) {
        return `Error reading document: ${error.message}`;
      }
    },
  }),
  usage: 'read documents from the knowledge base if needed.',
};

const createListDocumentsTool = (conversationId) => ({
  ...betaZodTool({
    name: 'list_documents',
    description: 'Lists all documents in the team knowledge base with their IDs and titles.',
    inputSchema: z.object({}),
    run: async () => {
      try {
        const { getKnowledge } = require('~/models/TeamKnowledge');
        const docs = await getKnowledge(conversationId);
        if (!docs || docs.length === 0) {
          return 'No documents found in the knowledge base.';
        }
        return docs.map((d) => `- ${d.title} (ID: ${d.documentId})`).join('\n');
      } catch (error) {
        return `Error listing documents: ${error.message}`;
      }
    },
  }),
  usage: 'list available documents to see what context is available.',
});

const createSearchDocumentsTool = (conversationId) => ({
  ...betaZodTool({
    name: 'search_documents',
    description: 'Performs a semantic search over the team knowledge base.',
    inputSchema: z.object({
      query: z.string().describe('The search query string.'),
    }),
    run: async ({ query }) => {
      try {
        const { searchKnowledge } = require('~/models/TeamKnowledge');
        const chunks = await searchKnowledge(conversationId, query, 5);
        if (!chunks || chunks.length === 0) {
          return 'No relevant documents found.';
        }

        // Fetch titles for better context
        // We need to re-fetch titles because searchKnowledge chunks might not have them if they are just vector results
        // Actually searchKnowledge implementation in TeamKnowledge.js returns { text, documentId, score, metadata }
        // We can try to look up titles if possible, or just return IDs.
        // Let's optimize: searchKnowledge implementation I viewed earlier (line 290) returns text/docId/score/meta.
        // It does NOT join with the main doc to get the title.
        // I should probably fetch titles here to be helpful.
        const { TeamKnowledge } = require('~/models/TeamKnowledge');
        const docIds = [...new Set(chunks.map((c) => c.documentId))];
        const titles = await TeamKnowledge.find({ documentId: { $in: docIds } })
          .select('documentId title')
          .lean();
        const titleMap = titles.reduce((acc, t) => ({ ...acc, [t.documentId]: t.title }), {});

        const formattedResults = chunks
          .map((chunk, i) => {
            const title = titleMap[chunk.documentId] || 'Unknown Document';
            const rangeInfo = chunk.metadata?.loc?.lines
              ? ` (Lines ${chunk.metadata.loc.lines.from}-${chunk.metadata.loc.lines.to})`
              : '';
            return `### Search Result ${i + 1}: "${title}" (ID: ${chunk.documentId})${rangeInfo}\n${chunk.text}`;
          })
          .join('\n\n');

        return `### Search Results for "${query}":\n\n${formattedResults}`;
      } catch (error) {
        return `Error searching documents: ${error.message}`;
      }
    },
  }),
  usage: 'find relevant information in the knowledge base.',
});

const createAskUserTool = () => ({
  name: 'ask_user',
  description:
    'Ask the user a clarifying question to proceed. CAUTION: This pauses execution until the user replies. Use only if absolutely necessary to resolve ambiguity.',
  input_schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user.',
      },
    },
    required: ['question'],
  },
});

module.exports = {
  readKnowledgeDocumentTool,
  createListDocumentsTool,
  createSearchDocumentsTool,
  createAskUserTool,
};
