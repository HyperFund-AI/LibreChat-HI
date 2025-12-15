/**
 * Shared client utilities for Team Knowledge Base:
 * - stable dedupe keys
 * - matching existing KB documents
 * - saved/modified state detection
 *
 * This is intentionally UI-agnostic and can be used by:
 * - Team document action bar
 * - Artifact document bar (in-message)
 * - Artifact sidebar/pane button
 */

/**
 * Minimal shape of a knowledge document as returned by the API.
 * Keep this lightweight to avoid coupling to any specific API type export.
 */
export type KnowledgeDocumentLike = {
  documentId?: string;
  title?: string;
  content?: string;
  messageId?: string;
  updatedAt?: string;
  createdAt?: string;
  tags?: string[];
  /**
   * Optional field: if your API includes it, we can match directly.
   * (Recommended when implementing dedupe/upsert behavior on the backend.)
   */
  dedupeKey?: string;
};

export type KnowledgeDocState = 'missing' | 'saved' | 'modified';

/**
 * Normalizes a string for use in keys (dedupe keys, title comparisons).
 * - stable across whitespace/punctuation changes
 * - short, safe, and deterministic
 */
export function normalizeKeyPart(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 64);
}

/**
 * Normalizes content for comparison (helps avoid false "modified" due to line endings).
 * Note: we do NOT aggressively trim all whitespace; only normalize line endings and
 * remove trailing whitespace on each line to reduce noisy diffs.
 */
export function normalizeContentForCompare(value: string): string {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trimEnd();
}

/**
 * Builds a stable knowledge-base dedupe key.
 *
 * IMPORTANT: You requested that all document saves refer to the same "thing" regardless of where
 * they come from (teamdoc bar, artifact bar, artifact pane) — so there is no prefix like "artifact:".
 *
 * Recommended inputs:
 * - `sourceId`: a stable identifier for the document source (prefer artifact identifier; fallback to messageId)
 * - `name`: a stable name (prefer filename if available; fallback to title)
 */
export function buildKnowledgeDedupeKey(params: { sourceId?: string; name: string }): string {
  const name = normalizeKeyPart(params.name);
  const sourceId = normalizeKeyPart(params.sourceId ?? '');

  // If sourceId is missing, fall back to name only (still deterministic, but less collision-proof).
  return sourceId ? `${sourceId}:${name}` : name;
}

/**
 * Find an existing KB document matching the given inputs.
 *
 * Matching priority:
 * 1) `dedupeKey` field match (best, requires backend to return/store dedupeKey)
 * 2) fallback match by (messageId + normalized title/name)
 */
export function findExistingKnowledgeDoc(params: {
  docs: KnowledgeDocumentLike[] | undefined | null;
  dedupeKey?: string;
  messageId?: string;
  name?: string; // filename/title
}): KnowledgeDocumentLike | undefined {
  const docs = params.docs ?? [];
  const dedupeKey = (params.dedupeKey ?? '').trim();
  const msgId = (params.messageId ?? '').trim();
  const normalizedName = params.name ? normalizeKeyPart(params.name) : '';

  if (dedupeKey) {
    const byDedupeKey = docs.find((d) => String(d?.dedupeKey ?? '').trim() === dedupeKey);
    if (byDedupeKey) {
      return byDedupeKey;
    }
  }

  if (msgId && normalizedName) {
    return docs.find((d) => {
      const dMsgId = String(d?.messageId ?? '').trim();
      const dTitle = normalizeKeyPart(String(d?.title ?? ''));
      return dMsgId === msgId && dTitle === normalizedName;
    });
  }

  return undefined;
}

/**
 * Compute whether the given content is already saved in KB, modified, or missing.
 */
export function getKnowledgeDocState(params: {
  docs: KnowledgeDocumentLike[] | undefined | null;
  content: string;
  dedupeKey?: string;
  messageId?: string;
  name?: string; // filename/title
}): { state: KnowledgeDocState; existing?: KnowledgeDocumentLike } {
  const existing = findExistingKnowledgeDoc({
    docs: params.docs,
    dedupeKey: params.dedupeKey,
    messageId: params.messageId,
    name: params.name,
  });

  if (!existing) {
    return { state: 'missing' };
  }

  const existingContent = normalizeContentForCompare(String(existing.content ?? ''));
  const currentContent = normalizeContentForCompare(params.content);

  if (existingContent === currentContent) {
    return { state: 'saved', existing };
  }

  return { state: 'modified', existing };
}
