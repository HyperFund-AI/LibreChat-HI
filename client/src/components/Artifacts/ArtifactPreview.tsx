import React, { memo, useMemo, useEffect, useRef, type MutableRefObject } from 'react';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import supersub from 'remark-supersub';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import {
  SandpackPreview,
  SandpackProvider,
  useSandpack,
} from '@codesandbox/sandpack-react/unstyled';
import type {
  SandpackProviderProps,
  SandpackPreviewRef,
} from '@codesandbox/sandpack-react/unstyled';
import type { PluggableList } from 'unified';
import type { TStartupConfig } from 'librechat-data-provider';
import type { ArtifactFiles } from '~/common';
import { sharedFiles, sharedOptions } from '~/utils/artifacts';
import { langSubset } from '~/utils';

/**
 * Markdown preview component - renders markdown directly using react-markdown
 * Much more performant for streaming than Sandpack
 */
const MarkdownPreview = memo(function MarkdownPreview({
  content,
}: {
  content: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);

  const rehypePlugins: PluggableList = useMemo(
    () => [
      [rehypeKatex],
      [
        rehypeHighlight,
        {
          detect: true,
          ignoreMissing: true,
          subset: langSubset,
        },
      ],
    ],
    [],
  );

  const remarkPlugins: PluggableList = useMemo(
    () => [
      supersub,
      remarkGfm,
      [remarkMath, { singleDollarTextMath: false }],
    ],
    [],
  );

  // Auto-scroll to bottom during streaming
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [content]);

  return (
    <div
      ref={contentRef}
      className="h-full w-full overflow-auto bg-white p-6 dark:bg-gray-900"
    >
      <article className="prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown
          /** @ts-ignore */
          remarkPlugins={remarkPlugins}
          /** @ts-ignore */
          rehypePlugins={rehypePlugins}
        >
          {content || ''}
        </ReactMarkdown>
      </article>
    </div>
  );
});

/**
 * Inner component that uses Sandpack's updateFile API for smooth streaming updates
 * This avoids remounting the entire Sandpack provider on each file change
 */
const PreviewWithUpdater = memo(function PreviewWithUpdater({
  fileKey,
  currentCode,
  files,
  previewRef,
}: {
  fileKey: string;
  currentCode?: string;
  files: ArtifactFiles;
  previewRef: MutableRefObject<SandpackPreviewRef>;
}) {
  const { sandpack } = useSandpack();
  const lastCodeRef = useRef<string | null>(null);

  // Get the current code to display
  const fileContent = files[fileKey];
  const codeFromFiles = typeof fileContent === 'string' ? fileContent : '';
  const code = currentCode ?? codeFromFiles;

  // Update files programmatically for smooth streaming
  useEffect(() => {
    if (!code || code === lastCodeRef.current) {
      return;
    }
    lastCodeRef.current = code;
    sandpack.updateFile('/' + fileKey, code);
  }, [code, fileKey, sandpack]);

  return (
    <SandpackPreview
      showOpenInCodeSandbox={false}
      showRefreshButton={false}
      tabIndex={0}
      ref={previewRef}
    />
  );
});

export const ArtifactPreview = memo(function ({
  files,
  fileKey,
  template,
  sharedProps,
  previewRef,
  currentCode,
  startupConfig,
}: {
  files: ArtifactFiles;
  fileKey: string;
  template: SandpackProviderProps['template'];
  sharedProps: Partial<SandpackProviderProps>;
  previewRef: MutableRefObject<SandpackPreviewRef>;
  currentCode?: string;
  startupConfig?: TStartupConfig;
}) {
  // Check if this is a markdown artifact
  const isMarkdown = fileKey === 'content.md';

  // Use refs to store initial files - this prevents SandpackProvider remounts during streaming
  // The PreviewWithUpdater component handles live updates via updateFile API
  const initialFilesRef = useRef<ArtifactFiles | null>(null);
  const lastFileKeyRef = useRef<string | null>(null);

  // Get content from files
  const fileContent = files[fileKey];
  const codeFromFiles = typeof fileContent === 'string' ? fileContent : '';
  const code = currentCode ?? codeFromFiles;

  // Compute current files for initial capture (for Sandpack)
  const computedFiles = useMemo((): ArtifactFiles => {
    if (Object.keys(files).length === 0) {
      return files;
    }
    if (!code) {
      return files;
    }
    return {
      ...files,
      [fileKey]: code,
    };
  }, [files, fileKey, code]);

  // Reset initial files when artifact changes (different fileKey indicates different artifact type)
  if (lastFileKeyRef.current !== null && lastFileKeyRef.current !== fileKey) {
    initialFilesRef.current = null;
  }
  lastFileKeyRef.current = fileKey;

  // Capture initial files only once per artifact
  if (initialFilesRef.current === null && Object.keys(computedFiles).length > 0) {
    initialFilesRef.current = computedFiles;
  }

  const initialFiles = initialFilesRef.current ?? computedFiles;

  const options: typeof sharedOptions = useMemo(() => {
    const baseOptions = {
      ...sharedOptions,
      classes: {
        'sp-preview-container': 'sp-preview-container-no-padding',
        'sp-preview': 'sp-preview-no-padding',
      },
    };
    if (!startupConfig) {
      return baseOptions;
    }
    return {
      ...baseOptions,
      bundlerURL: template === 'static' ? startupConfig.staticBundlerURL : startupConfig.bundlerURL,
    };
  }, [startupConfig, template]);

  // For markdown, render directly with react-markdown (much faster streaming)
  if (isMarkdown) {
    return (
      <div className="h-full w-full p-0 m-0">
        <MarkdownPreview content={code} />
      </div>
    );
  }

  if (Object.keys(files).length === 0) {
    return null;
  }

  return (
    <div className="h-full w-full p-0 m-0">
      <SandpackProvider
        files={{ ...initialFiles, ...sharedFiles }}
        options={options}
        {...sharedProps}
        template={template}
      >
        <PreviewWithUpdater
          fileKey={fileKey}
          currentCode={currentCode}
          files={files}
          previewRef={previewRef}
        />
      </SandpackProvider>
    </div>
  );
});
