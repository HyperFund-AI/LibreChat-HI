import { useRef, useState, useEffect, useMemo } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dataService, type KnowledgeDocument } from 'librechat-data-provider';
import { BookmarkPlus, CheckCircle, Code, Loader2, Play, RefreshCw, X } from 'lucide-react';
import { useSetRecoilState, useResetRecoilState } from 'recoil';
import {
  Button,
  Spinner,
  useMediaQuery,
  Radio,
  useToastContext,
  TooltipAnchor,
} from '@librechat/client';
import type { SandpackPreviewRef, CodeEditorRef } from '@codesandbox/sandpack-react';
import { useShareContext, useMutationState } from '~/Providers';
import useArtifacts from '~/hooks/Artifacts/useArtifacts';
import DownloadArtifact from './DownloadArtifact';
import ArtifactVersion from './ArtifactVersion';
import ArtifactTabs from './ArtifactTabs';
import { CopyCodeButton } from './Code';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';
import { normalizeKeyPart } from '~/common';

const MAX_BLUR_AMOUNT = 32;
const MAX_BACKDROP_OPACITY = 0.3;

export default function Artifacts() {
  const localize = useLocalize();
  const { isMutating } = useMutationState();
  const { isSharedConvo } = useShareContext();
  const isMobile = useMediaQuery('(max-width: 868px)');
  const { conversationId } = useParams<{ conversationId: string }>();
  const { showToast } = useToastContext();
  const queryClient = useQueryClient();
  const editorRef = useRef<CodeEditorRef>();
  const previewRef = useRef<SandpackPreviewRef>();
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [height, setHeight] = useState(90);
  const [isDragging, setIsDragging] = useState(false);
  const [blurAmount, setBlurAmount] = useState(0);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(90);
  const setArtifactsVisible = useSetRecoilState(store.artifactsVisibility);
  const resetCurrentArtifactId = useResetRecoilState(store.currentArtifactId);

  const tabOptions = [
    {
      value: 'code',
      label: localize('com_ui_code'),
      icon: <Code className="size-4" />,
    },
    {
      value: 'preview',
      label: localize('com_ui_preview'),
      icon: <Play className="size-4" />,
    },
  ];

  useEffect(() => {
    setIsMounted(true);
    const delay = isMobile ? 50 : 30;
    const timer = setTimeout(() => setIsVisible(true), delay);
    return () => {
      clearTimeout(timer);
      setIsMounted(false);
    };
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile) {
      setBlurAmount(0);
      return;
    }

    const minHeightForBlur = 50;
    const maxHeightForBlur = 100;

    if (height <= minHeightForBlur) {
      setBlurAmount(0);
    } else if (height >= maxHeightForBlur) {
      setBlurAmount(MAX_BLUR_AMOUNT);
    } else {
      const progress = (height - minHeightForBlur) / (maxHeightForBlur - minHeightForBlur);
      setBlurAmount(Math.round(progress * MAX_BLUR_AMOUNT));
    }
  }, [height, isMobile]);

  const {
    activeTab,
    setActiveTab,
    currentIndex,
    currentArtifact,
    orderedArtifactIds,
    setCurrentArtifactId,
  } = useArtifacts();

  /**
   * Keep sidebar Save-to-KB button in sync with KB:
   * - dedupe by a stable key (prefer identifier if available, else messageId)
   * - detect saved/modified state by comparing current content to the stored KB doc
   */
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

  const normalizedTitle = useMemo(
    () => normalizeKeyPart(currentArtifact?.title ?? 'artifact'),
    [currentArtifact?.title],
  );

  // TODO ...
  const kbDedupeKey = useMemo(() => {
    const identifier = String(currentArtifact?.identifier ?? '');
    const stableIdPart =
      identifier && identifier !== 'lc-no-identifier'
        ? identifier
        : String(currentArtifact?.messageId ?? '');
    return `artifact:${stableIdPart}:${normalizedTitle}`;
  }, [currentArtifact?.identifier, currentArtifact?.messageId, normalizedTitle]);

  const existingKbDoc = useMemo(() => {
    // Prefer direct dedupeKey match (new server field)
    const byDedupeKey = kbDocuments.find((d) => d?.dedupeKey === kbDedupeKey);
    if (byDedupeKey) {
      return byDedupeKey;
    }

    // Fallback for older docs: match by (messageId + normalized title)
    const msgId = String(currentArtifact?.messageId ?? '');
    if (!msgId) {
      return undefined;
    }
    return kbDocuments.find(
      (d: any) =>
        String(d?.messageId ?? '') === msgId &&
        normalizeKeyPart(String(d?.title ?? '')) === normalizedTitle,
    );
  }, [kbDocuments, kbDedupeKey, currentArtifact?.messageId, normalizedTitle]);

  const currentKbContent = currentArtifact?.content ?? '';
  const isKbSaved =
    Boolean(existingKbDoc) && String(existingKbDoc?.content ?? '') === currentKbContent;
  const isKbModified = Boolean(existingKbDoc) && !isKbSaved;

  const saveToKnowledgeMutation = useMutation({
    mutationFn: async () => {
      if (!conversationId) {
        throw new Error('No conversation ID');
      }
      if (!currentArtifact) {
        throw new Error('No artifact');
      }

      const title = currentArtifact.title ?? 'Artifact';
      const content = currentArtifact.content ?? '';
      if (!content) {
        throw new Error('No content');
      }

      return dataService.saveToTeamKnowledge(conversationId, {
        title,
        content,
        messageId: currentArtifact.messageId ?? '',
        tags: ['artifact'],
        dedupeKey: kbDedupeKey,
      });
    },
    onSuccess: () => {
      showToast({
        message: 'Document saved to team knowledge base',
        status: 'success',
      });
      queryClient.invalidateQueries({ queryKey: ['teamKnowledge', conversationId] });
    },
    onError: (error: Error) => {
      showToast({
        message: `Failed to save: ${error.message}`,
        status: 'error',
      });
    },
  });

  const handleDragStart = (e: React.PointerEvent) => {
    setIsDragging(true);
    dragStartY.current = e.clientY;
    dragStartHeight.current = height;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleDragMove = (e: React.PointerEvent) => {
    if (!isDragging) {
      return;
    }

    const deltaY = dragStartY.current - e.clientY;
    const viewportHeight = window.innerHeight;
    const deltaPercentage = (deltaY / viewportHeight) * 100;
    const newHeight = Math.max(10, Math.min(100, dragStartHeight.current + deltaPercentage));

    setHeight(newHeight);
  };

  const handleDragEnd = (e: React.PointerEvent) => {
    if (!isDragging) {
      return;
    }

    setIsDragging(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);

    // Snap to positions based on final height
    if (height < 30) {
      closeArtifacts();
    } else if (height > 95) {
      setHeight(100);
    } else if (height < 60) {
      setHeight(50);
    } else {
      setHeight(90);
    }
  };

  if (!currentArtifact || !isMounted) {
    return null;
  }

  const handleRefresh = () => {
    setIsRefreshing(true);
    const client = previewRef.current?.getClient();
    if (client) {
      client.dispatch({ type: 'refresh' });
    }
    setTimeout(() => setIsRefreshing(false), 750);
  };

  const closeArtifacts = () => {
    if (isMobile) {
      setIsClosing(true);
      setIsVisible(false);
      setTimeout(() => {
        setArtifactsVisible(false);
        setIsClosing(false);
        setHeight(90);
      }, 250);
    } else {
      resetCurrentArtifactId();
      setArtifactsVisible(false);
    }
  };

  const backdropOpacity =
    blurAmount > 0
      ? (Math.min(blurAmount, MAX_BLUR_AMOUNT) / MAX_BLUR_AMOUNT) * MAX_BACKDROP_OPACITY
      : 0;

  return (
    <Tabs.Root value={activeTab} onValueChange={setActiveTab} asChild>
      <div className="flex h-full w-full flex-col">
        {/* Mobile backdrop with dynamic blur */}
        {isMobile && (
          <div
            className={cn(
              'fixed inset-0 z-[99] bg-black will-change-[opacity,backdrop-filter]',
              isVisible && !isClosing
                ? 'transition-all duration-300'
                : 'pointer-events-none opacity-0 backdrop-blur-none transition-opacity duration-150',
              blurAmount < 8 && isVisible && !isClosing ? 'pointer-events-none' : '',
            )}
            style={{
              opacity: isVisible && !isClosing ? backdropOpacity : 0,
              backdropFilter: isVisible && !isClosing ? `blur(${blurAmount}px)` : 'none',
              WebkitBackdropFilter: isVisible && !isClosing ? `blur(${blurAmount}px)` : 'none',
            }}
            onClick={blurAmount >= 8 ? closeArtifacts : undefined}
            aria-hidden="true"
          />
        )}
        <div
          className={cn(
            'flex w-full flex-col bg-surface-primary text-xl text-text-primary',
            isMobile
              ? cn(
                  'fixed inset-x-0 bottom-0 z-[100] rounded-t-[20px] shadow-[0_-10px_60px_rgba(0,0,0,0.35)]',
                  isVisible && !isClosing
                    ? 'translate-y-0 opacity-100'
                    : 'duration-250 translate-y-full opacity-0 transition-all',
                  isDragging ? '' : 'transition-all duration-300',
                )
              : cn(
                  'h-full shadow-2xl',
                  isVisible && !isClosing
                    ? 'duration-350 translate-x-0 opacity-100 transition-all'
                    : 'translate-x-5 opacity-0 transition-all duration-300',
                ),
          )}
          style={isMobile ? { height: `${height}vh` } : { overflow: 'hidden' }}
        >
          {isMobile && (
            <div
              className="flex flex-shrink-0 cursor-grab items-center justify-center bg-surface-primary-alt pb-1.5 pt-2.5 active:cursor-grabbing"
              onPointerDown={handleDragStart}
              onPointerMove={handleDragMove}
              onPointerUp={handleDragEnd}
              onPointerCancel={handleDragEnd}
            >
              <div className="h-1 w-12 rounded-full bg-border-xheavy opacity-40 transition-all duration-200 active:opacity-60" />
            </div>
          )}

          {/* Header */}
          <div
            className={cn(
              'flex flex-shrink-0 items-center justify-between gap-2 border-b border-border-light bg-surface-primary-alt px-3 py-2 transition-all duration-300',
              isMobile ? 'justify-center' : 'overflow-hidden',
            )}
          >
            {!isMobile && (
              <div
                className={cn(
                  'flex items-center transition-all duration-500',
                  isVisible && !isClosing
                    ? 'translate-x-0 opacity-100'
                    : '-translate-x-2 opacity-0',
                )}
              >
                <Radio
                  options={tabOptions}
                  value={activeTab}
                  onChange={setActiveTab}
                  disabled={isMutating && activeTab !== 'code'}
                />
              </div>
            )}

            <div
              className={cn(
                'flex items-center gap-2 transition-all duration-500',
                isMobile ? 'min-w-max' : '',
                isVisible && !isClosing ? 'translate-x-0 opacity-100' : 'translate-x-2 opacity-0',
              )}
            >
              {activeTab === 'preview' && (
                <TooltipAnchor
                  description={localize('com_ui_refresh')}
                  side="bottom"
                  render={
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={handleRefresh}
                      disabled={isRefreshing}
                      aria-label={localize('com_ui_refresh')}
                    >
                      {isRefreshing ? (
                        <Spinner size={16} />
                      ) : (
                        <RefreshCw size={16} className="transition-transform duration-200" />
                      )}
                    </Button>
                  }
                />
              )}
              {activeTab !== 'preview' && isMutating && (
                <RefreshCw size={16} className="animate-spin text-text-secondary" />
              )}
              {orderedArtifactIds.length > 1 && (
                <ArtifactVersion
                  currentIndex={currentIndex}
                  totalVersions={orderedArtifactIds.length}
                  onVersionChange={(index) => {
                    const target = orderedArtifactIds[index];
                    if (target) {
                      setCurrentArtifactId(target);
                    }
                  }}
                />
              )}
              <CopyCodeButton content={currentArtifact.content ?? ''} />
              <DownloadArtifact artifact={currentArtifact} />
              <TooltipAnchor
                description={
                  isKbSaved ? localize('com_ui_saved_in_kb') : localize('com_ui_save_to_knowledge')
                }
                side="bottom"
                render={
                  <div className="inline-flex cursor-default">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        if (!conversationId) {
                          showToast({
                            message: 'Cannot save: conversation not found',
                            status: 'error',
                          });
                          return;
                        }
                        // Prevent duplicate saves:
                        // - avoid re-saving when KB already matches current content
                        // - avoid double triggers while mutation is in-flight
                        if (saveToKnowledgeMutation.isLoading || isKbSaved) {
                          return;
                        }
                        saveToKnowledgeMutation.mutate();
                      }}
                      disabled={!conversationId || saveToKnowledgeMutation.isLoading || isKbSaved}
                      aria-label={
                        isKbSaved ? localize('com_ui_saved') : localize('com_ui_save_to_knowledge')
                      }
                    >
                      {saveToKnowledgeMutation.isLoading ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : isKbSaved ? (
                        <CheckCircle size={16} className="text-green-500" />
                      ) : (
                        <BookmarkPlus
                          size={16}
                          className={isKbModified ? 'text-amber-500' : undefined}
                        />
                      )}
                    </Button>
                  </div>
                }
              />
              <TooltipAnchor
                description={localize('com_ui_close')}
                side="bottom"
                render={
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={closeArtifacts}
                    aria-label={localize('com_ui_close')}
                  >
                    <X size={16} />
                  </Button>
                }
              />
            </div>
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-surface-primary">
            <div className="absolute inset-0 flex flex-col">
              <ArtifactTabs
                artifact={currentArtifact}
                editorRef={editorRef as React.MutableRefObject<CodeEditorRef>}
                previewRef={previewRef as React.MutableRefObject<SandpackPreviewRef>}
                isSharedConvo={isSharedConvo}
              />
            </div>

            <output
              className={cn(
                'absolute inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm transition-opacity duration-300 ease-in-out',
                isRefreshing ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
              )}
              aria-hidden={!isRefreshing}
            >
              <div
                className={cn(
                  'transition-transform duration-300 ease-in-out',
                  isRefreshing ? 'scale-100' : 'scale-95',
                )}
              >
                <Spinner size={24} />
              </div>
            </output>
          </div>

          {isMobile && (
            <div className="flex-shrink-0 border-t border-border-light bg-surface-primary-alt p-2">
              <Radio
                fullWidth
                options={tabOptions}
                value={activeTab}
                onChange={setActiveTab}
                disabled={isMutating && activeTab !== 'code'}
              />
            </div>
          )}
        </div>
      </div>
    </Tabs.Root>
  );
}
