import React, { useState, useCallback } from 'react';
import copy from 'copy-to-clipboard';
import { useParams } from 'react-router-dom';
import { Copy, Download, BookmarkPlus, CheckCircle, FileText, Loader2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dataService } from 'librechat-data-provider';
import { Button, useToastContext } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface TeamDocumentActionsProps {
  content: string;
  messageId: string;
  isTeamResponse?: boolean;
  className?: string;
}

/**
 * Extracts a title from markdown content
 */
const extractTitle = (content: string): string => {
  // Try to find first heading
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();

  const h2Match = content.match(/^##\s+(.+)$/m);
  if (h2Match) return h2Match[1].trim();

  // Try to find first bold text
  const boldMatch = content.match(/\*\*([^*]+)\*\*/);
  if (boldMatch) return boldMatch[1].trim();

  // Default
  return `Team Document - ${new Date().toLocaleDateString()}`;
};

/**
 * Actions toolbar for team documents with copy, download, and save to knowledge buttons
 */
export default function TeamDocumentActions({
  content,
  messageId,
  isTeamResponse = false,
  className,
}: TeamDocumentActionsProps) {
  const _localize = useLocalize();
  const { showToast } = useToastContext();
  const queryClient = useQueryClient();
  const { conversationId } = useParams<{ conversationId: string }>();

  const [isCopied, setIsCopied] = useState(false);
  const [isSaved, setIsSaved] = useState(false);

  // Mutation for saving to knowledge base
  const saveToKnowledgeMutation = useMutation({
    mutationFn: async () => {
      if (!conversationId) throw new Error('No conversation ID');

      const title = extractTitle(content);
      return dataService.saveToTeamKnowledge(conversationId, {
        title,
        content,
        messageId,
        tags: ['team-output'],
      });
    },
    onSuccess: () => {
      setIsSaved(true);
      showToast({
        message: 'Document saved to team knowledge base',
        status: 'success',
      });
      // Invalidate knowledge cache
      queryClient.invalidateQueries({ queryKey: ['teamKnowledge', conversationId] });
      setTimeout(() => setIsSaved(false), 3000);
    },
    onError: (error: Error) => {
      showToast({
        message: `Failed to save: ${error.message}`,
        status: 'error',
      });
    },
  });

  // Copy to clipboard
  const handleCopy = useCallback(() => {
    copy(content, { format: 'text/plain' });
    setIsCopied(true);
    showToast({
      message: 'Copied to clipboard',
      status: 'success',
    });
    setTimeout(() => setIsCopied(false), 3000);
  }, [content, showToast]);

  // Download as markdown file
  const handleDownload = useCallback(() => {
    const title = extractTitle(content);
    const filename = `${title.replace(/[^a-z0-9]/gi, '_').substring(0, 50)}.md`;

    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showToast({
      message: `Downloaded ${filename}`,
      status: 'success',
    });
  }, [content, showToast]);

  // Save to knowledge base
  const handleSaveToKnowledge = useCallback(() => {
    if (!conversationId) {
      showToast({
        message: 'Cannot save: conversation not found',
        status: 'error',
      });
      return;
    }
    saveToKnowledgeMutation.mutate();
  }, [conversationId, saveToKnowledgeMutation, showToast]);

  // Only show for team responses with sufficient content
  if (!isTeamResponse || content.length < 100) {
    return null;
  }

  return (
    <div
      className={cn(
        'mt-3 flex items-center gap-2 rounded-lg border border-border-light bg-surface-secondary p-2',
        className,
      )}
    >
      <FileText className="h-4 w-4 text-text-secondary" />
      {/* eslint-disable-next-line i18next/no-literal-string */}
      <span className="text-xs font-medium text-text-secondary">Team Document</span>

      <div className="ml-auto flex items-center gap-1">
        {/* Copy Button */}
        <Button
          size="sm"
          variant="ghost"
          onClick={handleCopy}
          className="h-8 gap-1.5 px-2 text-xs"
          title="Copy as Markdown"
        >
          {isCopied ? (
            <CheckCircle className="h-4 w-4 text-green-500" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
          <span className="hidden sm:inline">{isCopied ? 'Copied!' : 'Copy'}</span>
        </Button>

        {/* Download Button */}
        <Button
          size="sm"
          variant="ghost"
          onClick={handleDownload}
          className="h-8 gap-1.5 px-2 text-xs"
          title="Download as Markdown file"
        >
          <Download className="h-4 w-4" />
          {/* eslint-disable-next-line i18next/no-literal-string */}
          <span className="hidden sm:inline">Download</span>
        </Button>

        {/* Save to Knowledge Button */}
        {conversationId && (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleSaveToKnowledge}
            disabled={saveToKnowledgeMutation.isPending || isSaved}
            className={cn('h-8 gap-1.5 px-2 text-xs', isSaved && 'text-green-500')}
            title="Save to team knowledge base"
          >
            {(() => {
              if (saveToKnowledgeMutation.isPending) {
                return <Loader2 className="h-4 w-4 animate-spin" />;
              }
              if (isSaved) {
                return <CheckCircle className="h-4 w-4" />;
              }
              return <BookmarkPlus className="h-4 w-4" />;
            })()}
            <span className="hidden sm:inline">{isSaved ? 'Saved!' : 'Save to KB'}</span>
          </Button>
        )}
      </div>
    </div>
  );
}
