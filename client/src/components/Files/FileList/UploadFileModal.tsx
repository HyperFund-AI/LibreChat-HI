import React, { useState, ChangeEvent } from 'react';
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const UploadFileModal = ({ open, onOpenChange }) => {
  const localize = useLocalize();
  const [file, setFile] = useState<File | null>(null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'w-11/12 overflow-x-auto p-3 shadow-2xl dark:bg-gray-700 dark:text-white lg:w-2/3 xl:w-2/5',
        )}
      >
        <DialogHeader>
          <DialogTitle className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-200">
            {localize('com_ui_upload_a_file')}
          </DialogTitle>
        </DialogHeader>
        <div className="flex w-full flex-col p-0 sm:p-6 sm:pb-0 sm:pt-4">
          <div className="flex w-full flex-row">
            <div className="hidden w-1/5 sm:block">
              <img />
            </div>
            <div className="flex w-full flex-col text-center sm:w-4/5 sm:text-left">
              <div className="italic">{localize('com_ui_upload_square_file_less_than_100kb')}</div>
              <div className="mt-4 flex w-full flex-row items-center bg-[#f9f9f9] p-2">
                <div className="w-1/2 sm:w-1/3">
                  <Button>{localize('com_ui_choose_file')}</Button>
                </div>
                <div className="w-1/2 sm:w-1/3"> {localize('com_ui_no_file_chosen')}</div>
              </div>
            </div>
          </div>
          <div className="mt-3 flex w-full flex-col">
            <label htmlFor="name">{localize('com_ui_name')}</label>
            <label className="hidden text-[#808080] sm:block">
              {localize('com_ui_name_of_uploaded_file')}
            </label>
            <Input type="text" id="name" name="name" placeholder={localize('com_ui_name')} />
          </div>

          <div className="mt-3 flex w-full flex-col">
            <label htmlFor="purpose">{localize('com_ui_purpose')}</label>
            <label className="hidden text-[#808080] sm:block">
              {localize('com_ui_purpose_of_uploaded_file')}
            </label>
            <Input
              type="text"
              id="purpose"
              name="purpose"
              placeholder={localize('com_ui_purpose')}
            />
          </div>

          <div className="mt-3 flex w-full flex-row justify-between">
            <div className="hidden w-1/3 sm:block">
              <span className="font-bold">{localize('com_ui_learn_about_file_purpose')}</span>
            </div>
            <div className="flex w-full flex-row justify-evenly sm:w-1/3">
              <Button
                className="mr-3 w-full rounded-md border border-black bg-white p-0 text-black hover:bg-white"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                {localize('com_ui_cancel')}
              </Button>
              <Button
                className="w-full rounded-md border border-black bg-black p-0 text-white"
                onClick={() => {
                  console.log('upload file');
                }}
              >
                {localize('com_ui_upload')}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default UploadFileModal;
