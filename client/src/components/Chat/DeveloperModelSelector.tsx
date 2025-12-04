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
  // All hooks must be called unconditionally at the top level
  const developerMode = useRecoilValue(store.developerMode);
  const { conversation } = useChatContext();
  const { setOption } = useSetIndexOptions();
  const modelsQuery = useGetModelsQuery();

  const availableModels = modelsQuery.data?.[EModelEndpoint.anthropic] ?? [];
  const currentModel = conversation?.model ?? '';
  const isAnthropicEndpoint = conversation?.endpoint === EModelEndpoint.anthropic;

  // Filter to latest Sonnet and Opus models available from the API
  // Finds the latest version of each model family (e.g., latest Sonnet, latest Opus)
  const filteredModels = useMemo(() => {
    if (!isAnthropicEndpoint) {
      return [];
    }

    // Debug: Always log in developer mode to help diagnose issues
    if (developerMode) {
      console.log('[DeveloperModelSelector] Available Anthropic models from API:', availableModels);
      console.log('[DeveloperModelSelector] Total models:', availableModels.length);
    }

    if (availableModels.length === 0) {
      if (developerMode) {
        console.warn('[DeveloperModelSelector] No models available from API. This could indicate:');
        console.warn("  - API key doesn't have access to models");
        console.warn("  - Models haven't loaded yet");
        console.warn('  - API endpoint issue');
      }
      return [];
    }

    // Find ALL Sonnet models (any version) - we want the latest available
    const allSonnetModels = availableModels.filter((model) => {
      // Match any Sonnet model:
      // - claude-sonnet-* (any version)
      // - claude-3-*-sonnet-* (Claude 3.x Sonnet models)
      const matches = model.includes('sonnet') && model.startsWith('claude');

      if (developerMode && matches) {
        console.log('[DeveloperModelSelector] ✓ Found Sonnet model:', model);
      }
      return matches;
    });

    // Find ALL Opus models (any version) - we want the latest available
    const allOpusModels = availableModels.filter((model) => {
      // Match any Opus model:
      // - claude-opus-* (any version)
      // - claude-3-*-opus-* (Claude 3.x Opus models)
      const matches = model.includes('opus') && model.startsWith('claude');

      if (developerMode && matches) {
        console.log('[DeveloperModelSelector] ✓ Found Opus model:', model);
      }
      return matches;
    });

    // Helper function to extract version info for sorting
    const getModelVersion = (model: string) => {
      // Extract version numbers (e.g., "4-5" from "claude-sonnet-4-5")
      const versionMatch = model.match(/claude-(?:sonnet|opus)-(\d+)-(\d+)/);
      const major = versionMatch ? parseInt(versionMatch[1], 10) : 0;
      const minor = versionMatch ? parseInt(versionMatch[2], 10) : 0;

      // Extract date suffix (YYYYMMDD format)
      const dateMatch = model.match(/-(\d{8})$/);
      const date = dateMatch ? dateMatch[1] : null;

      // Handle Claude 3.x models (e.g., claude-3-5-sonnet)
      const claude3Match = model.match(/claude-3-(\d+)-(?:sonnet|opus)/);
      if (claude3Match) {
        const claude3Minor = parseInt(claude3Match[1], 10);
        return { major: 3, minor: claude3Minor, patch: 0, date };
      }

      return { major, minor, patch: 0, date };
    };

    // Sort and get the latest Sonnet model
    const latestSonnet =
      allSonnetModels.length > 0
        ? allSonnetModels.sort((a, b) => {
            const versionA = getModelVersion(a);
            const versionB = getModelVersion(b);

            // Compare by major version first
            if (versionA.major !== versionB.major) {
              return versionB.major - versionA.major;
            }

            // Then minor version
            if (versionA.minor !== versionB.minor) {
              return versionB.minor - versionA.minor;
            }

            // Then by date (if present)
            if (versionA.date && versionB.date) {
              return versionB.date.localeCompare(versionA.date);
            }

            // Models with dates come before models without dates
            if (versionA.date && !versionB.date) return -1;
            if (!versionA.date && versionB.date) return 1;

            return 0;
          })[0]
        : null;

    // Sort and get the latest Opus model
    const latestOpus =
      allOpusModels.length > 0
        ? allOpusModels.sort((a, b) => {
            const versionA = getModelVersion(a);
            const versionB = getModelVersion(b);

            // Compare by major version first
            if (versionA.major !== versionB.major) {
              return versionB.major - versionA.major;
            }

            // Then minor version
            if (versionA.minor !== versionB.minor) {
              return versionB.minor - versionA.minor;
            }

            // Then by date (if present)
            if (versionA.date && versionB.date) {
              return versionB.date.localeCompare(versionA.date);
            }

            // Models with dates come before models without dates
            if (versionA.date && !versionB.date) return -1;
            if (!versionA.date && versionB.date) return 1;

            return 0;
          })[0]
        : null;

    const models: string[] = [];

    // Only include models that are actually available from the API
    // Don't use defaults - if API doesn't return it, it's likely not available
    if (latestOpus) {
      models.push(latestOpus);
    }

    if (latestSonnet) {
      models.push(latestSonnet);
    }

    // Debug: Log results
    if (developerMode) {
      console.log('[DeveloperModelSelector] Final filtered models:', models);
      console.log('[DeveloperModelSelector] All Sonnet models found:', allSonnetModels);
      console.log('[DeveloperModelSelector] All Opus models found:', allOpusModels);
      console.log('[DeveloperModelSelector] Latest Sonnet selected:', latestSonnet);
      console.log('[DeveloperModelSelector] Latest Opus selected:', latestOpus);

      if (models.length === 0) {
        console.warn('[DeveloperModelSelector] ⚠️ No Sonnet or Opus models found in API response');
        console.warn('[DeveloperModelSelector] Available models:', availableModels);
      } else if (models.length === 1) {
        console.warn('[DeveloperModelSelector] ⚠️ Only found one model:', models[0]);
        if (!latestSonnet) {
          console.warn(
            '[DeveloperModelSelector] Sonnet not available - check API key permissions or model availability',
          );
        }
        if (!latestOpus) {
          console.warn(
            '[DeveloperModelSelector] Opus not available - check API key permissions or model availability',
          );
        }
      }
    }

    return models;
  }, [availableModels, isAnthropicEndpoint, developerMode]);

  // Default to Sonnet if current model is not in the filtered list
  const selectedModel = useMemo(() => {
    if (filteredModels.includes(currentModel)) {
      return currentModel;
    }
    // Default to Sonnet (claude-sonnet-4-20250514)
    return filteredModels.find((m) => m.includes('sonnet')) ?? filteredModels[0] ?? '';
  }, [currentModel, filteredModels]);

  // Set default to Sonnet if current model is not in filtered list
  useEffect(() => {
    if (!isAnthropicEndpoint || filteredModels.length === 0) {
      return;
    }

    // Prefer claude-sonnet-4-20250514, fallback to any Sonnet, then any model
    const defaultSonnet =
      filteredModels.find((m) => m.includes('sonnet-4-20250514')) ??
      filteredModels.find((m) => m.includes('sonnet')) ??
      filteredModels[0];

    if (!defaultSonnet) {
      return;
    }

    // If current model is not in filtered list, set to default Sonnet
    if (currentModel && !filteredModels.includes(currentModel)) {
      setOption('model')(defaultSonnet);
    } else if (!currentModel) {
      // If no model is set, default to Sonnet
      setOption('model')(defaultSonnet);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredModels.join(','), currentModel, isAnthropicEndpoint]); // Run when filtered models or current model changes

  // Only render if developer mode is enabled and using Anthropic endpoint
  if (!developerMode || !isAnthropicEndpoint || filteredModels.length === 0) {
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
