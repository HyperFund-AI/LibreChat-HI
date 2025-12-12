import React from 'react';
import { useLocalize } from '~/hooks';
import DocumentActionBar from '~/components/Document/DocumentActionBar';

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
      }}
    />
  );
}
