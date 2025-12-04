import React, { useState, useRef } from 'react';
import { useUploadPersonaMutation } from 'librechat-data-provider/react-query';
import { OGDialogTemplate, OGDialog, Input, Label, useToastContext } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { NotificationSeverity } from '~/common';
import { cn, removeFocusOutlines, defaultTextProps } from '~/utils';

type UploadPersonaDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const UploadPersonaDialog: React.FC<UploadPersonaDialogProps> = ({ open, onOpenChange }) => {
  const [title, setTitle] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadPersonaMutation = useUploadPersonaMutation();
  const { showToast } = useToastContext();
  const localize = useLocalize();

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const fileExt = file.name.toLowerCase().split('.').pop();
    const allowedExtensions = ['md', 'txt', 'markdown'];

    if (!allowedExtensions.includes(fileExt || '')) {
      showToast({
        message: 'Invalid file type. Only .md, .txt, and .markdown files are allowed.',
        severity: NotificationSeverity.ERROR,
      });
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      return;
    }

    setSelectedFile(file);
    // Set default title from filename (without extension)
    if (!title) {
      const baseName = file.name.replace(/\.[^/.]+$/, '');
      setTitle(baseName);
    }
  };

  const handleUpload = () => {
    if (!selectedFile) {
      showToast({
        message: 'Please select a file to upload',
        severity: NotificationSeverity.ERROR,
      });
      return;
    }

    const formData = new FormData();
    formData.append('personaFile', selectedFile);
    if (title) {
      formData.append('title', title);
    }
    // Default to anthropic endpoint for persona presets
    formData.append('endpoint', 'anthropic');

    uploadPersonaMutation.mutate(formData, {
      onSuccess: (preset) => {
        showToast({
          message: `Persona preset "${preset.title || title}" uploaded successfully`,
        });
        // Reset form
        setSelectedFile(null);
        setTitle('');
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        onOpenChange(false);
      },
      onError: (error: Error) => {
        showToast({
          message: error.message || 'Failed to upload persona file',
          severity: NotificationSeverity.ERROR,
        });
      },
    });
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Reset form when closing
      setSelectedFile(null);
      setTitle('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
    onOpenChange(newOpen);
  };

  return (
    <OGDialog open={open} onOpenChange={handleOpenChange}>
      <OGDialogTemplate
        title="Upload Persona File"
        className="z-[90] w-11/12 sm:w-1/2 md:w-2/5"
        overlayClassName="z-[80]"
        showCloseButton={true}
        main={
          <div className="flex w-full flex-col items-center gap-4">
            <div className="grid w-full items-center gap-2">
              <Label htmlFor="persona-file" className="text-left text-sm font-medium">
                Persona File (.md, .txt, or .markdown)
              </Label>
              <input
                ref={fileInputRef}
                id="persona-file"
                type="file"
                accept=".md,.txt,.markdown"
                onChange={handleFileChange}
                className={cn(
                  defaultTextProps,
                  'flex h-10 w-full cursor-pointer rounded-md border border-gray-300 bg-white px-3 py-2 text-sm file:mr-4 file:rounded-md file:border-0 file:bg-gray-100 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-gray-700 hover:file:bg-gray-200 dark:border-gray-600 dark:bg-gray-800 dark:file:bg-gray-700 dark:file:text-gray-300',
                  removeFocusOutlines,
                )}
              />
              {selectedFile && (
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  Selected: {selectedFile.name} ({(selectedFile.size / 1024).toFixed(2)} KB)
                </p>
              )}
            </div>
            <div className="grid w-full items-center gap-2">
              <Label htmlFor="preset-title" className="text-left text-sm font-medium">
                Preset Name (optional)
              </Label>
              <Input
                id="preset-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Leave empty to use filename"
                className={cn(
                  defaultTextProps,
                  'flex h-10 max-h-10 w-full resize-none px-3 py-2',
                  removeFocusOutlines,
                )}
              />
            </div>
          </div>
        }
        selection={{
          selectHandler: handleUpload,
          selectClasses: 'bg-green-500 hover:bg-green-600 dark:hover:bg-green-600 text-white',
          selectText: 'Upload',
          selectDisabled: !selectedFile || uploadPersonaMutation.isPending,
        }}
      />
    </OGDialog>
  );
};

export default UploadPersonaDialog;
