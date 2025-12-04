import { useMemo, useEffect } from 'react';
import { SelectDropDown } from '@librechat/client';
import { useRecoilValue } from 'recoil';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import { EModelEndpoint } from 'librechat-data-provider';
import { useChatContext } from '~/Providers';
import useSetIndexOptions from '~/hooks/Conversations/useSetIndexOptions';
import store from '~/store';
import { cn, cardStyle } from '~/utils';

/**
 * Developer mode model selector - allows selecting between latest Sonnet and Opus models
 * Only shows when developer mode is enabled and conversation uses Anthropic endpoint
 */
export default function DeveloperModelSelector() {
  const developerMode = useRecoilValue(store.developerMode);
  const { conversation } = useChatContext();
  const { setOption } = useSetIndexOptions();
  const modelsQuery = useGetModelsQuery();

  // Only show if developer mode is enabled and using Anthropic endpoint
  if (!developerMode || conversation?.endpoint !== EModelEndpoint.anthropic) {
    return null;
  }

  const availableModels = modelsQuery.data?.[EModelEndpoint.anthropic] ?? [];
  const currentModel = conversation?.model ?? '';

  // Filter to latest Sonnet and Opus models (4.5 versions)
  const filteredModels = useMemo(() => {
    const sonnetModels = availableModels.filter((model) => {
      // Match claude-sonnet-4-5 with optional date suffix (YYYYMMDD format)
      return /^claude-sonnet-4-5(-\d{8})?$/.test(model);
    });

    const opusModels = availableModels.filter((model) => {
      // Match claude-opus-4-5 with optional date suffix (YYYYMMDD format)
      return /^claude-opus-4-5(-\d{8})?$/.test(model);
    });

    // Get the latest version of each (with date suffix if available, otherwise base name)
    const latestSonnet = sonnetModels.length > 0
      ? sonnetModels.sort((a, b) => {
          // Sort by date suffix if present, latest first
          const dateA = a.match(/-(\d+)$/)?.[1] ?? '0';
          const dateB = b.match(/-(\d+)$/)?.[1] ?? '0';
          return dateB.localeCompare(dateA);
        })[0]
      : null;

    const latestOpus = opusModels.length > 0
      ? opusModels.sort((a, b) => {
          // Sort by date suffix if present, latest first
          const dateA = a.match(/-(\d+)$/)?.[1] ?? '0';
          const dateB = b.match(/-(\d+)$/)?.[1] ?? '0';
          return dateB.localeCompare(dateA);
        })[0]
      : null;

    const models: string[] = [];
    if (latestOpus) {
      models.push(latestOpus);
    }
    if (latestSonnet) {
      models.push(latestSonnet);
    }

    // If no models found, provide defaults
    if (models.length === 0) {
      // Default to known latest versions
      models.push('claude-opus-4-5-20251101');
      models.push('claude-sonnet-4-5-20250929');
    }

    return models;
  }, [availableModels]);

  // Default to Opus if current model is not in the filtered list
  const selectedModel = useMemo(() => {
    if (filteredModels.includes(currentModel)) {
      return currentModel;
    }
    // Default to Opus
    return filteredModels.find((m) => m.includes('opus')) ?? filteredModels[0] ?? '';
  }, [currentModel, filteredModels]);

  // Set default to Opus if current model is not in filtered list
  useEffect(() => {
    if (filteredModels.length === 0) {
      return;
    }

    const defaultOpus = filteredModels.find((m) => m.includes('opus'));
    if (!defaultOpus) {
      return;
    }

    // If current model is not in filtered list, set to default Opus
    if (currentModel && !filteredModels.includes(currentModel)) {
      setOption('model')(defaultOpus);
    } else if (!currentModel) {
      // If no model is set, default to Opus
      setOption('model')(defaultOpus);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredModels.join(','), currentModel]); // Run when filtered models or current model changes

  if (filteredModels.length === 0) {
    return null;
  }

  return (
    <SelectDropDown
      value={selectedModel}
      setValue={setOption('model')}
      availableValues={filteredModels}
      showAbove={false}
      showLabel={false}
      className={cn(
        cardStyle,
        'z-50 flex h-[32px] w-48 min-w-48 flex-none items-center justify-center px-3 text-xs ring-0 hover:cursor-pointer',
      )}
    />
  );
}
