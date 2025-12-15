import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import copy from 'copy-to-clipboard';
import { useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dataService } from 'librechat-data-provider';
import {
  BookmarkPlus,
  CheckCircle,
  PanelRightOpen,
  Copy,
  Download,
  FileText,
  Loader2,
  X,
} from 'lucide-react';
import { Button, useToastContext } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export type DocumentActionBarPrimaryToggle = {
  /** If provided, the bar becomes clickable (open/close style). */
  onToggle: () => void;
  isOpen: boolean;
  openLabel?: string;
  closeLabel?: string;
};

export type SaveToKnowledgeConfig = {
  /** If omitted, will be taken from route params. */
  conversationId?: string;
  messageId?: string;
  dedupeKey?: string;
  /** Defaults to extracted title. */
  title?: string;
  /** Defaults to ['team-output'] */
  tags?: string[];
  /** Optional query key to invalidate after save. Defaults to ['teamKnowledge', conversationId]. */
  invalidateQueryKey?: unknown[];
  /**
   * Override save behavior entirely (e.g., artifacts could save elsewhere).
   * If not provided, defaults to dataService.saveToTeamKnowledge.
   */
  onSave?: (args: {
    conversationId: string;
    title: string;
    content: string;
    messageId?: string;
    tags: string[];
  }) => Promise<unknown>;
};

export type DocumentActionBarProps = {
  /** Content used for copy/download (and save, if enabled). */
  content: string;

  /** Optional resolver (e.g., artifact could pass currentCode). Takes precedence over `content`. */
  resolveContent?: () => string;

  /** Message ID for save-to-knowledge (if enabled). */
  messageId?: string;

  /** Rendered label at the left (e.g. localize('com_ui_team_document') or localize('com_ui_artifacts')). */
  label?: React.ReactNode;

  /** Title shown in the bar. Defaults to extracted title from content. */
  title?: string;

  /** Optional action text shown next to the open/close icon. If omitted, it uses the open/close text derived from `primaryToggle`. */
  actionText?: React.ReactNode;

  /** If provided, turns the bar into an artifact-like open/close indicator. */
  primaryToggle?: DocumentActionBarPrimaryToggle;

  /** Show copy button. Default: true */
  showCopy?: boolean;

  /** Show download button. Default: true */
  showDownload?: boolean;

  /** Save-to-knowledge support (team KB). If not provided, save button is hidden. */
  saveToKnowledge?: SaveToKnowledgeConfig;

  /** Hide the bar entirely if content is below this length. Default: 0 */
  minContentLength?: number;

  className?: string;
};

/**
 * Extracts a title from markdown-ish content.
 * Intentionally mirrors the TeamDocumentActions logic so both are consistent.
 */
export const extractDocumentTitle = (content: string): string => {
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();

  const h2Match = content.match(/^##\s+(.+)$/m);
  if (h2Match) return h2Match[1].trim();

  const boldMatch = content.match(/\*\*([^*]+)\*\*/);
  if (boldMatch) return boldMatch[1].trim();

  return `Document - ${new Date().toLocaleDateString()}`;
};

const sanitizeFilename = (name: string): string =>
  name
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 60) || 'document';

const StableLabel = ({
  primary,
  secondary,
  showSecondary,
}: {
  primary: React.ReactNode;
  secondary: React.ReactNode;
  showSecondary: boolean;
}) => (
  <span className="relative hidden sm:inline-block">
    {/* Reserve width using the primary label to prevent layout shift */}
    <span className={cn('block whitespace-nowrap', showSecondary ? 'invisible' : '')}>
      {primary}
    </span>
    <span
      className={cn('absolute inset-0 block whitespace-nowrap', !showSecondary ? 'invisible' : '')}
    >
      {secondary}
    </span>
  </span>
);

function DocumentActionBar({
  content,
  resolveContent,
  messageId,
  label,
  title,
  actionText: actionTextProp,
  primaryToggle,
  showCopy = true,
  showDownload = true,
  saveToKnowledge,
  minContentLength = 0,
  className,
}: DocumentActionBarProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const queryClient = useQueryClient();
  const { conversationId: conversationIdFromRoute } = useParams<{ conversationId: string }>();

  const [isCopied, setIsCopied] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [isToggleHovered, setIsToggleHovered] = useState(false);

  const setToggleHoveredOn = useCallback(() => setIsToggleHovered(true), []);
  const setToggleHoveredOff = useCallback(() => setIsToggleHovered(false), []);

  // TODO hack around for alt tab / tab switch messing up hover effects.
  useEffect(() => {
    const reset = () => setIsToggleHovered(false);

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        reset();
      }
    };

    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const resolvedContent = useMemo(() => {
    try {
      return resolveContent?.() ?? content ?? '';
    } catch {
      return content ?? '';
    }
  }, [resolveContent, content]);

  const effectiveTitle = useMemo(
    () => title ?? extractDocumentTitle(resolvedContent),
    [title, resolvedContent],
  );

  const effectiveConversationId = saveToKnowledge?.conversationId ?? conversationIdFromRoute ?? '';

  const actionText = useMemo(() => {
    if (actionTextProp != null) {
      return actionTextProp;
    }
    if (primaryToggle) {
      return primaryToggle.isOpen
        ? (primaryToggle.closeLabel ?? localize('com_ui_click_to_close'))
        : (primaryToggle.openLabel ?? localize('com_ui_artifact_click'));
    }
    return null;
  }, [actionTextProp, primaryToggle, localize]);

  const canSaveToKnowledge = Boolean(saveToKnowledge && effectiveConversationId);

  const saveToKnowledgeMutation = useMutation({
    mutationFn: async () => {
      if (!saveToKnowledge) {
        throw new Error('Save is not configured');
      }
      if (!effectiveConversationId) {
        throw new Error('No conversation ID');
      }

      const tags = saveToKnowledge.tags ?? ['team-output'];
      const payload = {
        conversationId: effectiveConversationId,
        title: saveToKnowledge.title ?? effectiveTitle,
        content: resolvedContent,
        messageId: saveToKnowledge.messageId ?? messageId,
        tags,
      };

      if (saveToKnowledge.onSave) {
        return saveToKnowledge.onSave(payload);
      }

      return dataService.saveToTeamKnowledge(effectiveConversationId, {
        title: payload.title,
        content: payload.content,
        messageId: payload.messageId,
        tags: payload.tags,
      });
    },
    onSuccess: () => {
      setIsSaved(true);
      showToast({
        message: 'Document saved to team knowledge base',
        status: 'success',
      });

      const key =
        saveToKnowledge?.invalidateQueryKey ??
        (effectiveConversationId ? ['teamKnowledge', effectiveConversationId] : undefined);

      if (key) {
        queryClient.invalidateQueries({ queryKey: key });
      }

      setTimeout(() => setIsSaved(false), 3000);
    },
    onError: (error: Error) => {
      showToast({
        message: `Failed to save: ${error.message}`,
        status: 'error',
      });
    },
  });

  const handleCopy = useCallback(
    (e?: React.SyntheticEvent) => {
      e?.stopPropagation?.();

      if (!resolvedContent) {
        return;
      }
      copy(resolvedContent, { format: 'text/plain' });
      setIsCopied(true);
      showToast({
        message: 'Copied to clipboard',
        status: 'success',
      });
      setTimeout(() => setIsCopied(false), 3000);
    },
    [resolvedContent, showToast],
  );

  const handleDownload = useCallback(
    (e?: React.SyntheticEvent) => {
      e?.stopPropagation?.();

      if (!resolvedContent) {
        return;
      }

      const filename = `${sanitizeFilename(effectiveTitle)}.md`;
      const blob = new Blob([resolvedContent], { type: 'text/markdown;charset=utf-8' });
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
    },
    [resolvedContent, effectiveTitle, showToast],
  );

  const handleSave = useCallback(
    (e?: React.SyntheticEvent) => {
      e?.stopPropagation?.();

      if (!canSaveToKnowledge) {
        showToast({
          message: 'Cannot save: conversation not found',
          status: 'error',
        });
        return;
      }
      saveToKnowledgeMutation.mutate();
    },
    [canSaveToKnowledge, saveToKnowledgeMutation, showToast],
  );

  if (!resolvedContent || resolvedContent.length < minContentLength) {
    return null;
  }

  const overlayToggleButtonClassName = cn(
    'absolute inset-0 z-10 rounded-lg',
    'transition-all duration-200 ease-in-out',
    'hover:bg-surface-hover hover:shadow-sm hover:ring-1 hover:ring-inset hover:ring-border-medium',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-secondary',
    'active:bg-surface-hover',
  );

  return (
    <div
      className={cn(
        'relative mt-3 flex items-center gap-2 rounded-lg border border-border-light bg-surface-secondary p-2',
        primaryToggle?.onToggle &&
          primaryToggle.isOpen &&
          cn(
            'border-border-medium',
            'shadow-sm',
            'ring-border-medium/40 ring-1 ring-inset',
            'before:pointer-events-none before:absolute before:inset-0 before:rounded-lg',
            "before:bg-surface-hover before:opacity-50 before:content-['']",
          ),
        className,
      )}
    >
      {primaryToggle?.onToggle ? (
        <button
          type="button"
          onClick={primaryToggle.onToggle}
          onMouseEnter={setToggleHoveredOn}
          onMouseLeave={setToggleHoveredOff}
          onFocus={setToggleHoveredOn}
          onBlur={setToggleHoveredOff}
          className={overlayToggleButtonClassName}
          aria-pressed={primaryToggle.isOpen}
          aria-label={
            primaryToggle.isOpen
              ? (primaryToggle.closeLabel ?? localize('com_ui_click_to_close'))
              : (primaryToggle.openLabel ?? localize('com_ui_artifact_click'))
          }
        />
      ) : null}

      <div className="pointer-events-none relative z-20 flex min-w-0 flex-1 items-center gap-2">
        <FileText className="h-4 w-4 shrink-0 text-text-secondary" />

        <div className="min-w-0 flex-1">
          {label != null ? (
            <div className="truncate text-xs font-medium text-text-secondary">{label}</div>
          ) : null}
          <div className="min-w-0 truncate text-xs font-medium text-text-primary">
            {effectiveTitle}
          </div>
        </div>

        {primaryToggle?.onToggle ? (
          <div
            className={cn(
              'ml-auto flex items-center gap-2 pr-1 text-text-secondary',
              'transition-[color,opacity] duration-200 ease-in-out',
              isToggleHovered ? 'text-text-primary opacity-100' : 'opacity-70',
            )}
          >
            {actionText != null ? (
              <span
                className={cn(
                  'whitespace-nowrap text-xs',
                  'transition-[color,opacity] duration-200 ease-in-out',
                  isToggleHovered
                    ? 'text-text-primary opacity-100'
                    : 'text-text-secondary opacity-80',
                )}
              >
                {actionText}
              </span>
            ) : null}
            {primaryToggle.isOpen ? (
              <X className="h-4 w-4" />
            ) : (
              <PanelRightOpen className="h-4 w-4" strokeWidth={1.2} />
            )}
          </div>
        ) : null}
      </div>

      <div
        className={cn(
          'pointer-events-auto',
          'relative z-30 ml-auto flex items-center gap-1 rounded-md p-1.5',
          'before:pointer-events-none before:absolute before:inset-0 before:z-[-1] before:rounded-md',
          "before:bg-surface-secondary before:opacity-50 before:content-['']",
        )}
      >
        {/* Copy */}
        {showCopy ? (
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
            <StableLabel
              primary={localize('com_ui_copy_to_clipboard')}
              secondary={localize('com_ui_copied')}
              showSecondary={isCopied}
            />
          </Button>
        ) : null}

        {/* Download */}
        {showDownload ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDownload}
            className="h-8 gap-1.5 px-2 text-xs"
            title="Download as Markdown file"
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">{localize('com_ui_download')}</span>
          </Button>
        ) : null}

        {/* Save to Knowledge */}
        {saveToKnowledge ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleSave}
            disabled={!canSaveToKnowledge || saveToKnowledgeMutation.isLoading || isSaved}
            className={cn('h-8 gap-1.5 px-2 text-xs', isSaved && 'text-green-500')}
            title="Save to team knowledge base"
          >
            {saveToKnowledgeMutation.isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isSaved ? (
              <CheckCircle className="h-4 w-4" />
            ) : (
              <BookmarkPlus className="h-4 w-4" />
            )}
            <StableLabel
              primary={localize('com_ui_save_to_knowledge')}
              secondary={localize('com_ui_saved')}
              showSecondary={isSaved}
            />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export default memo(DocumentActionBar);
