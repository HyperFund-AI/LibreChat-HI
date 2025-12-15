import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { dataService, type KnowledgeDocument } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import DocumentActionBar, { extractDocumentTitle } from '~/components/Document/DocumentActionBar';

interface TeamDocumentActionsProps {
  content: string;
  messageId: string;
  isTeamResponse?: boolean;
  className?: string;
}

/**
 * Team document action bar (copy, download, save-to-knowledge), built on the shared DocumentActionBar UI.
 */
export default function TeamDocumentActions({
  content,
  messageId,
  isTeamResponse = false,
  className,
}: TeamDocumentActionsProps) {
  const localize = useLocalize();
  const { conversationId } = useParams<{ conversationId: string }>();

  type KnowledgeDocumentWithDedupe = KnowledgeDocument & { dedupeKey?: string };
  const { data: knowledgeData } = useQuery(
    ['teamKnowledge', conversationId],
    () => {
      if (!conversationId) {
        throw new Error('No conversation ID');
      }
      return dataService.getTeamKnowledge(conversationId);
    },
    {
      enabled: !!conversationId,
      refetchOnWindowFocus: false,
    },
  );

  const kbDocuments = useMemo<KnowledgeDocumentWithDedupe[]>(
    () => (knowledgeData?.documents as KnowledgeDocumentWithDedupe[]) ?? [],
    [knowledgeData],
  );

  const title = useMemo(() => extractDocumentTitle(content), [content]);

  // Construct dedupe key for team docs (matches format in onSave below)
  const kbDedupeKey = `teamdoc:${messageId ?? ''}:${title}`;

  const existingKbDoc = useMemo(() => {
    const found = kbDocuments.find((d) => d.dedupeKey === kbDedupeKey);
    return found;
  }, [kbDocuments, kbDedupeKey]);

  const isKbSaved = useMemo(() => {
    // Also matched if content is identical (optional strictness)
    return Boolean(existingKbDoc && existingKbDoc.content === content);
  }, [existingKbDoc, content]);

  // Only show for team responses with sufficient content
  if (!isTeamResponse || content.length < 100) {
    return null;
  }

  return (
    <DocumentActionBar
      className={className}
      content={content}
      messageId={messageId}
      label={localize('com_ui_team_document')}
      minContentLength={100}
      saveToKnowledge={{
        messageId,
        tags: ['team-output'],
        isSaved: isKbSaved,
        onSave: ({ conversationId, title, content, messageId, tags }) =>
          dataService.saveToTeamKnowledge(conversationId, {
            title,
            content,
            messageId,
            tags,
            dedupeKey: kbDedupeKey,
          }),
      }}
    />
  );
}
