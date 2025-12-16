const { logger } = require('@librechat/data-schemas');

/**
 * Team Knowledge Base (KB) tools for Anthropic tool calls.
 *
 * Design goals:
 * - Standalone + minimal: no orchestration state, no pause/resume, no extra agent-loop helpers.
 * - Compatible with existing orchestrator patterns that expect:
 *   - A `tools` array of Anthropic tool definitions
 *   - A tool-execution switch that returns a string `tool_result`
 *
 * Tool names:
 * - list_documents
 * - search_documents
 * - read_knowledge_document
 */

const DEFAULT_SEARCH_K = 5;
const MAX_SEARCH_K = 10;

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function clampInt(value, min, max) {
  const n = toInt(value);
  if (n === null) return null;
  return Math.max(min, Math.min(max, n));
}

function normalizeString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function formatLineRange(meta) {
  const from = meta?.loc?.lines?.from;
  const to = meta?.loc?.lines?.to;
  if (typeof from === 'number' && typeof to === 'number') {
    return ` (Lines ${from}-${to})`;
  }
  return '';
}

function formatScore(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return '';
  return ` (score: ${score.toFixed(3)})`;
}

async function listDocuments(conversationId) {
  const { getKnowledge } = require('~/models/TeamKnowledge');

  if (!conversationId) {
    return 'Error: missing conversationId (cannot list documents).';
  }

  const docs = await getKnowledge(conversationId);
  if (!docs || docs.length === 0) {
    return 'No documents found in the knowledge base.';
  }

  return docs.map((d) => `- ${d.title} (ID: ${d.documentId})`).join('\n');
}

async function searchDocuments(conversationId, query, k) {
  const { searchKnowledge, TeamKnowledge } = require('~/models/TeamKnowledge');

  if (!conversationId) {
    return 'Error: missing conversationId (cannot search documents).';
  }

  const q = normalizeString(query);
  if (!q) {
    return 'Error: missing `query` (provide a non-empty search query).';
  }

  const desiredK = clampInt(k ?? DEFAULT_SEARCH_K, 1, MAX_SEARCH_K) ?? DEFAULT_SEARCH_K;

  const chunks = await searchKnowledge(conversationId, q, desiredK);
  if (!chunks || chunks.length === 0) {
    return `No relevant documents found for "${q}".`;
  }

  // Fetch titles for better context
  const docIds = [...new Set(chunks.map((c) => c.documentId).filter(Boolean))];
  const titles = await TeamKnowledge.find({ documentId: { $in: docIds } })
    .select('documentId title')
    .lean();

  const titleMap = (titles || []).reduce((acc, t) => {
    acc[t.documentId] = t.title;
    return acc;
  }, {});

  const formattedResults = chunks
    .map((chunk, i) => {
      const title = titleMap[chunk.documentId] || 'Unknown Document';
      const rangeInfo = formatLineRange(chunk.metadata);
      const scoreInfo = formatScore(chunk.score);
      return `### Search Result ${i + 1}: "${title}" (ID: ${chunk.documentId})${rangeInfo}${scoreInfo}\n${chunk.text}`;
    })
    .join('\n\n');

  return `### Search Results for "${q}":\n\n${formattedResults}`;
}

async function readKnowledgeDocument(documentId, startLine, endLine) {
  const { getKnowledgeDocument } = require('~/models/TeamKnowledge');

  const id = normalizeString(documentId);
  if (!id) {
    return 'Error: missing `document_id` (provide the document ID to read).';
  }

  const doc = await getKnowledgeDocument(id);
  if (!doc) {
    return `Error: Document with ID ${id} not found.`;
  }

  const content = doc.content;
  if (!content) {
    return `Error: Document "${doc.title}" (ID: ${doc.documentId}) has no content.`;
  }

  const start = toInt(startLine);
  const end = toInt(endLine);

  // No range: return entire document.
  if (start === null && end === null) {
    return `### Document: ${doc.title} (ID: ${doc.documentId})\n\n${content}`;
  }

  const lines = content.split('\n');
  const resolvedStart = start !== null && start > 0 ? start - 1 : 0;
  const resolvedEndExclusive = end !== null && end > 0 ? end : lines.length;

  if (resolvedStart >= lines.length) {
    return `Error: Start line ${startLine} is beyond document length (${lines.length} lines).`;
  }

  const startIdx = Math.max(0, resolvedStart);
  const endIdx = Math.max(startIdx + 1, Math.min(resolvedEndExclusive, lines.length));

  const selectedLines = lines.slice(startIdx, endIdx);
  const rangeInfo = ` (Lines ${startIdx + 1}-${endIdx})`;

  return `### Document: ${doc.title} (ID: ${doc.documentId})${rangeInfo}\n\n${selectedLines.join('\n')}`;
}

/**
 * Factory: returns Anthropic tool definitions bound to a conversationId.
 * These are "definitions only" (schema). Execution is handled by `executeKbToolCall`.
 */
function createKbTools(conversationId) {
  return [
    {
      name: 'list_documents',
      description: 'Lists all documents in the team knowledge base with their IDs and titles.',
      input_schema: { type: 'object', properties: {}, required: [] },
      __kb: { conversationId },
    },
    {
      name: 'search_documents',
      description: 'Performs a semantic search over the team knowledge base.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query string.' },
          k: {
            type: 'integer',
            description: `Number of results to return (1-${MAX_SEARCH_K}). Defaults to ${DEFAULT_SEARCH_K}.`,
          },
        },
        required: ['query'],
      },
      __kb: { conversationId },
    },
    {
      name: 'read_knowledge_document',
      description:
        'Reads the content of a document from the Team Knowledge Base. You can specify line ranges to read only a portion of the document.',
      input_schema: {
        type: 'object',
        properties: {
          document_id: {
            type: 'string',
            description: 'The unique ID of the document to read (e.g., from search results).',
          },
          start_line: {
            type: 'integer',
            description: 'Optional: The starting line number (1-based) to read from.',
          },
          end_line: {
            type: 'integer',
            description: 'Optional: The ending line number (1-based) to read to.',
          },
        },
        required: ['document_id'],
      },
      __kb: { conversationId },
    },
  ];
}

/**
 * Executes a KB tool call and returns string content suitable for a `tool_result` block.
 *
 * @param {Object} params
 * @param {string} params.toolName
 * @param {Object} params.toolInput
 * @param {string} params.conversationId
 * @returns {Promise<string>}
 */
async function executeKbToolCall({ toolName, toolInput = {}, conversationId }) {
  const safeToolName = typeof toolName === 'string' ? toolName : String(toolName);
  const safeConversationId = conversationId || 'N/A';

  let inputPreview = '';
  try {
    inputPreview = JSON.stringify(toolInput);
  } catch (err) {
    inputPreview = `[unstringifiable input: ${err?.message || String(err)}]`;
  }

  // Avoid log spam (and leaking too much doc content in logs)
  if (typeof inputPreview === 'string' && inputPreview.length > 800) {
    inputPreview = inputPreview.slice(0, 800) + '...';
  }

  const startedAt = Date.now();
  logger.debug(
    `[kbTools] executeKbToolCall start: tool=${safeToolName}, conversationId=${safeConversationId}, input=${inputPreview}`,
  );

  try {
    let result;

    switch (safeToolName) {
      case 'list_documents':
        result = await listDocuments(conversationId);
        break;

      case 'search_documents':
        result = await searchDocuments(conversationId, toolInput?.query, toolInput?.k);
        break;

      case 'read_knowledge_document':
        result = await readKnowledgeDocument(
          toolInput?.document_id,
          toolInput?.start_line,
          toolInput?.end_line,
        );
        break;

      default:
        result = `Error: Unknown KB tool "${safeToolName}".`;
        break;
    }

    const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
    const durationMs = Date.now() - startedAt;

    logger.debug(
      `[kbTools] executeKbToolCall done: tool=${safeToolName}, conversationId=${safeConversationId}, durationMs=${durationMs}, outputChars=${text.length}`,
    );

    return text;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logger.error('[kbTools] Tool execution error:', err);
    logger.debug(
      `[kbTools] executeKbToolCall failed: tool=${safeToolName}, conversationId=${safeConversationId}, durationMs=${durationMs}`,
    );
    return `Error executing "${safeToolName}": ${err?.message || String(err)}`;
  }
}

module.exports = {
  createKbTools,
  executeKbToolCall,
};
