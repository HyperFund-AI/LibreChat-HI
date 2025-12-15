import React, { memo, useMemo, useEffect, useRef, type MutableRefObject } from 'react';
import {
  SandpackPreview,
  SandpackProvider,
  useSandpack,
} from '@codesandbox/sandpack-react/unstyled';
import type {
  SandpackProviderProps,
  SandpackPreviewRef,
} from '@codesandbox/sandpack-react/unstyled';
import type { TStartupConfig } from 'librechat-data-provider';
import type { ArtifactFiles } from '~/common';
import { sharedFiles, sharedOptions } from '~/utils/artifacts';

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
  // Use refs to store initial files - this prevents SandpackProvider remounts during streaming
  // The PreviewWithUpdater component handles live updates via updateFile API
  const initialFilesRef = useRef<ArtifactFiles | null>(null);
  const lastFileKeyRef = useRef<string | null>(null);

  // Compute current files for initial capture
  const computedFiles = useMemo((): ArtifactFiles => {
    if (Object.keys(files).length === 0) {
      return files;
    }
    const fileContent = files[fileKey];
    const codeFromFiles = typeof fileContent === 'string' ? fileContent : '';
    const code = currentCode ?? codeFromFiles;

    if (!code) {
      return files;
    }

    return {
      ...files,
      [fileKey]: code,
    };
  }, [files, fileKey, currentCode]);

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
