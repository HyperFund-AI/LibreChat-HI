import { useEffect, useRef, useCallback, memo, useMemo } from 'react';
import debounce from 'lodash/debounce';
import { useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { dataService, type KnowledgeDocument } from 'librechat-data-provider';
import { useRecoilState, useSetRecoilState, useResetRecoilState } from 'recoil';
import type { Artifact } from '~/common';
import { normalizeKeyPart } from '~/common';
import { logger, isArtifactRoute } from '~/utils';
import { useLocalize } from '~/hooks';
import store from '~/store';
import DocumentActionBar from '~/components/Document/DocumentActionBar';

type ArtifactDocumentIndicatorProps = {
  artifact: Artifact | null;
  className?: string;
};

/**
 * Artifact indicator styled like the TeamDocumentActions toolbar,
 * wired to the artifact open/close behavior (recoil + panel visibility),
 * and reusing the shared `DocumentActionBar` for Copy/Download/Save-to-KB UI/logic.
 */
function ArtifactDocumentIndicator({ artifact, className }: ArtifactDocumentIndicatorProps) {
  const localize = useLocalize();
  const { conversationId } = useParams<{ conversationId: string }>();
  const location = useLocation();

  const setVisible = useSetRecoilState(store.artifactsVisibility);
  const [artifacts, setArtifacts] = useRecoilState(store.artifactsState);
  const [currentArtifactId, setCurrentArtifactId] = useRecoilState(store.currentArtifactId);
  const resetCurrentArtifactId = useResetRecoilState(store.currentArtifactId);
  const [visibleArtifacts, setVisibleArtifacts] = useRecoilState(store.visibleArtifacts);

  const isSelected =
    artifact?.id != null && artifact.id !== '' && artifact.id === currentArtifactId;

  const debouncedSetVisibleRef = useRef(
    debounce((artifactToSet: Artifact) => {
      logger.log(
        'artifacts_visibility',
        'Setting artifact to visible state from ArtifactDocumentIndicator',
        artifactToSet,
      );
      setVisibleArtifacts((prev) => ({
        ...prev,
        [artifactToSet.id]: artifactToSet,
      }));
    }, 750),
  );

  useEffect(() => {
    if (artifact == null || artifact.id == null || artifact.id === '') {
      return;
    }

    // Mirrors existing behavior: only eagerly registers artifacts as "visible artifacts"
    // while on the artifact route (where the panel UI is relevant).
    if (!isArtifactRoute(location.pathname)) {
      return;
    }

    const debouncedSetVisible = debouncedSetVisibleRef.current;
    debouncedSetVisible(artifact);

    return () => {
      debouncedSetVisible.cancel();
    };
  }, [artifact, location.pathname]);

  const handleToggleOpen = useCallback(() => {
    if (artifact == null || artifact.id == null || artifact.id === '') {
      return;
    }

    if (isSelected) {
      resetCurrentArtifactId();
      setVisible(false);
      return;
    }

    resetCurrentArtifactId();
    setVisible(true);

    // Ensure the artifact exists in the artifacts map when opening
    if (artifacts?.[artifact.id] == null) {
      setArtifacts(visibleArtifacts);
    }

    // Small delay mirrors existing behavior to allow panel visibility state to settle first
    setTimeout(() => {
      setCurrentArtifactId(artifact.id);
    }, 15);
  }, [
    artifact,
    isSelected,
    resetCurrentArtifactId,
    setVisible,
    artifacts,
    setArtifacts,
    visibleArtifacts,
    setCurrentArtifactId,
  ]);

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
    () => normalizeKeyPart(artifact?.title ?? 'Artifact'),
    [artifact?.title],
  );

  const kbDedupeKey = useMemo(() => {
    if (!artifact) {
      return '';
    }
    const identifier = String(artifact.identifier ?? '');
    const stableIdPart =
      identifier && identifier !== 'lc-no-identifier'
        ? identifier
        : String(artifact.messageId ?? '');
    return `artifact:${stableIdPart}:${normalizedTitle}`;
  }, [artifact, normalizedTitle]);

  const existingKbDoc = useMemo(() => {
    // Prefer direct dedupeKey match (new server field)
    const byDedupeKey = kbDocuments.find((d) => d?.dedupeKey === kbDedupeKey);
    if (byDedupeKey) {
      return byDedupeKey;
    }

    // Fallback for older docs: match by (messageId + normalized title)
    const msgId = String(artifact?.messageId ?? '');
    if (!msgId) {
      return undefined;
    }
    return kbDocuments.find(
      (d: any) =>
        String(d?.messageId ?? '') === msgId &&
        normalizeKeyPart(String(d?.title ?? '')) === normalizedTitle,
    );
  }, [kbDocuments, kbDedupeKey, artifact?.messageId, normalizedTitle]);

  const currentKbContent = artifact?.content ?? '';
  const isKbSaved =
    Boolean(existingKbDoc) && String(existingKbDoc?.content ?? '') === currentKbContent;

  if (artifact == null || artifact.id == null || artifact.id === '') {
    return null;
  }

  return (
    <DocumentActionBar
      className={className}
      content={artifact.content ?? ''}
      messageId={artifact.messageId}
      label={'Artifact' /*localize('com_ui_artifacts')*/}
      title={artifact.title ?? 'untitled'}
      primaryToggle={{
        onToggle: handleToggleOpen,
        isOpen: isSelected,
      }}
      saveToKnowledge={
        conversationId
          ? {
            conversationId,
            messageId: artifact.messageId,
            title: artifact.title ?? 'Artifact',
            tags: ['artifact'],
            invalidateQueryKey: ['teamKnowledge', conversationId],
            dedupeKey: kbDedupeKey,
            isSaved: isKbSaved,
          }
          : undefined
      }
    />
  );
}

export default memo(ArtifactDocumentIndicator);
