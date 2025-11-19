const { nanoid } = require('nanoid');
const { Tools } = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');

/**
 * Extracts domain from a URL
 * @param {string} url - The URL to extract domain from
 * @returns {string|null} - The domain or null if invalid
 */
function extractDomain(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }
  try {
    const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
    return urlObj.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Checks if a domain is allowed based on allowed/blocked domain lists
 * @param {string} url - The URL to check
 * @param {string[]|undefined} allowedDomains - List of allowed domains (if empty/undefined, all allowed)
 * @param {string[]|undefined} blockedDomains - List of blocked domains
 * @returns {boolean} - True if domain is allowed
 */
function isDomainAllowed(url, allowedDomains, blockedDomains) {
  const domain = extractDomain(url);
  if (!domain) {
    return false;
  }

  // Check blocked domains first
  if (blockedDomains && Array.isArray(blockedDomains) && blockedDomains.length > 0) {
    for (const blocked of blockedDomains) {
      const blockedDomain = extractDomain(blocked);
      if (!blockedDomain) continue;
      
      // Support wildcard domains (e.g., "*.example.com")
      if (blockedDomain.startsWith('*.')) {
        const baseDomain = blockedDomain.slice(2);
        if (domain === baseDomain || domain.endsWith(`.${baseDomain}`)) {
          return false;
        }
      } else if (domain === blockedDomain) {
        return false;
      }
    }
  }

  // Check allowed domains (if specified)
  if (allowedDomains && Array.isArray(allowedDomains) && allowedDomains.length > 0) {
    for (const allowed of allowedDomains) {
      const allowedDomain = extractDomain(allowed);
      if (!allowedDomain) continue;
      
      // Support wildcard domains (e.g., "*.example.com")
      if (allowedDomain.startsWith('*.')) {
        const baseDomain = allowedDomain.slice(2);
        if (domain === baseDomain || domain.endsWith(`.${baseDomain}`)) {
          return true;
        }
      } else if (domain === allowedDomain) {
        return true;
      }
    }
    // If allowed domains are specified but domain doesn't match, block it
    return false;
  }

  // If no restrictions, allow all (except blocked)
  return true;
}

/**
 * Filters search results based on domain restrictions
 * @param {object} data - Search result data
 * @param {string[]|undefined} allowedDomains - Allowed domains
 * @param {string[]|undefined} blockedDomains - Blocked domains
 * @returns {object} - Filtered search result data
 */
function filterSearchResults(data, allowedDomains, blockedDomains) {
  if (!data) {
    return data;
  }

  const filtered = { ...data };

  // Filter organic results
  if (Array.isArray(filtered.organic)) {
    filtered.organic = filtered.organic.filter((source) => {
      if (!source.link) return false;
      return isDomainAllowed(source.link, allowedDomains, blockedDomains);
    });
  }

  // Filter top stories
  if (Array.isArray(filtered.topStories)) {
    filtered.topStories = filtered.topStories.filter((source) => {
      if (!source.link) return false;
      return isDomainAllowed(source.link, allowedDomains, blockedDomains);
    });
  }

  return filtered;
}

/**
 * Creates a function to handle search results and stream them as attachments
 * @param {import('http').ServerResponse} res - The HTTP server response object
 * @param {object} [webSearchConfig] - Web search configuration with domain restrictions
 * @returns {{ onSearchResults: function(SearchResult, GraphRunnableConfig): void; onGetHighlights: function(string): void}} - Function that takes search results and returns or streams an attachment
 */
function createOnSearchResults(res, webSearchConfig) {
  const context = {
    sourceMap: new Map(),
    searchResultData: undefined,
    toolCallId: undefined,
    attachmentName: undefined,
    messageId: undefined,
    conversationId: undefined,
  };

  /**
   * @param {SearchResult} results
   * @param {GraphRunnableConfig} runnableConfig
   */
  function onSearchResults(results, runnableConfig) {
    logger.info(
      `[onSearchResults] user: ${runnableConfig.metadata.user_id} | thread_id: ${runnableConfig.metadata.thread_id} | run_id: ${runnableConfig.metadata.run_id}`,
      results,
    );

    if (!results.success) {
      logger.error(
        `[onSearchResults] user: ${runnableConfig.metadata.user_id} | thread_id: ${runnableConfig.metadata.thread_id} | run_id: ${runnableConfig.metadata.run_id} | error: ${results.error}`,
      );
      return;
    }

    const turn = runnableConfig.toolCall?.turn ?? 0;
    let data = { turn, ...structuredClone(results.data ?? {}) };
    
    // Filter results based on domain restrictions
    if (webSearchConfig) {
      const { allowedDomains, blockedDomains } = webSearchConfig;
      data = filterSearchResults(data, allowedDomains, blockedDomains);
    }
    
    context.searchResultData = data;

    // Map sources to links
    for (let i = 0; i < data.organic.length; i++) {
      const source = data.organic[i];
      if (source.link) {
        context.sourceMap.set(source.link, {
          type: 'organic',
          index: i,
          turn,
        });
      }
    }
    for (let i = 0; i < data.topStories.length; i++) {
      const source = data.topStories[i];
      if (source.link) {
        context.sourceMap.set(source.link, {
          type: 'topStories',
          index: i,
          turn,
        });
      }
    }

    context.toolCallId = runnableConfig.toolCall.id;
    context.messageId = runnableConfig.metadata.run_id;
    context.conversationId = runnableConfig.metadata.thread_id;
    context.attachmentName = `${runnableConfig.toolCall.name}_${context.toolCallId}_${nanoid()}`;

    const attachment = buildAttachment(context);

    if (!res.headersSent) {
      return attachment;
    }
    res.write(`event: attachment\ndata: ${JSON.stringify(attachment)}\n\n`);
  }

  /**
   * @param {string} link
   * @returns {void}
   */
  function onGetHighlights(link) {
    const source = context.sourceMap.get(link);
    if (!source) {
      return;
    }
    const { type, index } = source;
    const data = context.searchResultData;
    if (!data) {
      return;
    }
    if (data[type][index] != null) {
      data[type][index].processed = true;
    }

    const attachment = buildAttachment(context);
    res.write(`event: attachment\ndata: ${JSON.stringify(attachment)}\n\n`);
  }

  return {
    onSearchResults,
    onGetHighlights,
  };
}

/**
 * Helper function to build an attachment object
 * @param {object} context - The context containing attachment data
 * @returns {object} - The attachment object
 */
function buildAttachment(context) {
  return {
    messageId: context.messageId,
    toolCallId: context.toolCallId,
    conversationId: context.conversationId,
    name: context.attachmentName,
    type: Tools.web_search,
    [Tools.web_search]: context.searchResultData,
  };
}

module.exports = {
  createOnSearchResults,
};
