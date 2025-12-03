import React, { useRef, useState } from 'react';
import { v4 } from 'uuid';
import { FileSources, FileContext, EModelEndpoint } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import {
  OGDialog,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
  Button,
  useToastContext,
} from '@librechat/client';
import { useGetFiles, useUploadFileMutation } from '~/data-provider';
import { DataTable, columns } from './Table';
import { useLocalize } from '~/hooks';
import { Upload } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys } from 'librechat-data-provider';

export default function Files({ open, onOpenChange }) {
  const localize = useLocalize();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const [isUploading, setIsUploading] = useState(false);

  const uploadFile = useUploadFileMutation({
    onSuccess: () => {
      // Refetch files to update the list
      queryClient.invalidateQueries([QueryKeys.files]);
    },
  });

  const { data: files = [] } = useGetFiles<TFile[]>({
    select: (files) =>
      files.map((file) => {
        file.context = file.context ?? FileContext.unknown;
        file.filterSource = file.source === FileSources.firebase ? FileSources.local : file.source;
        return file;
      }),
  });

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files || event.target.files.length === 0) {
      return;
    }

    setIsUploading(true);
    const fileList = Array.from(event.target.files);
    let successCount = 0;
    let errorCount = 0;

    // Upload each file with global context enabled
    const uploadPromises = fileList.map(async (file) => {
      try {
        const file_id = v4();
        const formData = new FormData();
        formData.append('endpoint', EModelEndpoint.agents);
        formData.append('endpointType', EModelEndpoint.agents);
        formData.append('file', file, encodeURIComponent(file.name));
        formData.append('file_id', file_id);
        formData.append('message_file', 'true');
        formData.append('isGlobalContext', 'true');

        // If it's an image, get width/height
        if (file.type.startsWith('image/')) {
          const img = new Image();
          const objectUrl = URL.createObjectURL(file);
          await new Promise<void>((resolve, reject) => {
            img.onload = () => {
              formData.append('width', img.width.toString());
              formData.append('height', img.height.toString());
              URL.revokeObjectURL(objectUrl);
              resolve();
            };
            img.onerror = () => {
              URL.revokeObjectURL(objectUrl);
              reject(new Error('Failed to load image'));
            };
            img.src = objectUrl;
          });
        }

        await uploadFile.mutateAsync(formData);
        successCount++;
      } catch (error) {
        console.error('Error uploading file:', error);
        errorCount++;
      }
    });

    await Promise.all(uploadPromises);

    // Show toast based on results
    if (successCount > 0) {
      showToast({
        message: localize('com_ui_file_global_context_enabled'),
        status: 'success',
      });
    }
    if (errorCount > 0) {
      showToast({
        message: localize('com_ui_file_global_context_update_error'),
        status: 'error',
      });
    }

    // Reset the input
    event.target.value = '';
    setIsUploading(false);
  };

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent
        title={localize('com_nav_my_files')}
        className="w-11/12 bg-background text-text-primary shadow-2xl"
      >
        <OGDialogHeader>
          <div className="flex items-center justify-between">
            <OGDialogTitle>{localize('com_nav_my_files')}</OGDialogTitle>
            <Button
              variant="outline"
              onClick={handleUploadClick}
              disabled={isUploading}
              className="flex items-center gap-2"
            >
              <Upload className="h-4 w-4" />
              {isUploading ? localize('com_ui_uploading') : localize('com_ui_upload_files')}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileChange}
              tabIndex={-1}
            />
          </div>
        </OGDialogHeader>
        <DataTable columns={columns} data={files} />
      </OGDialogContent>
    </OGDialog>
  );
}
