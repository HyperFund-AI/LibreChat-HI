const {
  ARTIFACT_START,
  ARTIFACT_END,
  findAllArtifacts,
} = require('~/server/services/Artifacts/update');

/**
 * Generates a stable deduplication key for knowledgebase artifacts.
 *
 * Strategy:
 * 1. Prefer `identifier` if present (e.g. `pomodoro-app`).
 * 2. Fallback to normalized `title` if present.
 * 3. Fallback to `default-artifact`.
 *
 * The key format is `${conversationId}:${stableId}`.
 * NOT including messageId ensures that new versions of the "same" artifact update the same KB entry.
 *
 * @param {Object} params
 * @param {string} params.conversationId
 * @param {string} [params.title]
 * @param {string} [params.identifier]
 * @returns {string} The deduplication key
 */
const getArtifactDedupeKey = ({ conversationId, title, identifier }) => {
  let stableId = '';

  if (identifier) {
    stableId = identifier.trim();
  } else if (title) {
    stableId = String(title)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 64);
  }

  if (!stableId) {
    stableId = 'default-artifact';
  }

  return `${conversationId}:${stableId}`;
};

/**
 * extracted metadata from artifact tags
 * e.g. :::artifact{identifier="foo" type="text" title="Bar"}
 */
const parseArtifactMetadata = (text) => {
  const metadata = {};
  const metaRegex = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = metaRegex.exec(text)) !== null) {
    metadata[match[1]] = match[2];
  }
  return metadata;
};

/**
 * Extracts all artifacts from a message text and parses their metadata.
 * key logic:
 * - Uses `findAllArtifacts` to locate blocks.
 * - Parses metadata from the opening tag.
 * - Extracts inner content (stripping fences).
 *
 * @param {string} text
 * @returns {Array<{text: string, title?: string, identifier?: string, type?: string, content: string}>}
 */
const extractArtifactsWithMetadata = (text) => {
  if (!text) return [];

  const rawArtifacts = findAllArtifacts({ text });
  return rawArtifacts.map((art) => {
    // art.text is the full artifact block including :::
    const openTagEnd = art.text.indexOf('}');
    const openTag = art.text.substring(0, openTagEnd + 1);
    const metadata = parseArtifactMetadata(openTag);

    // Extract content logic similar to `update.js` but we just need the inner text
    // Assuming standard format: :::artifact{...}\n```\nCONTENT\n```\n:::
    // We can rely on replaceArtifactContent's logic or just regex for simple extraction
    // For robust extraction let's look for the code block
    const contentMatch = art.text.match(/```(?:\w+)?\n([\s\S]*?)\n```/);
    const content = contentMatch ? contentMatch[1] : '';

    return {
      fullText: art.text,
      ...metadata,
      content,
    };
  });
};

module.exports = {
  getArtifactDedupeKey,
  extractArtifactsWithMetadata,
  parseArtifactMetadata,
};
