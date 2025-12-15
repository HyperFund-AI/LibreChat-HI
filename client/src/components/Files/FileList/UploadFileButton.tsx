import React from 'react';
import { PlusIcon } from 'lucide-react';
import { Button } from '@librechat/client';
import { useLocalize } from '~/hooks';

type UploadFileProps = {
  onClick: () => void;
};

export default function UploadFileButton({ onClick }: UploadFileProps) {
  const localize = useLocalize();
  return (
    <div className="w-full">
      <Button className="w-full bg-black px-3 text-white" onClick={onClick}>
        <PlusIcon className="h-4 w-4 font-bold" />
        &nbsp; <span className="text-nowrap">{localize('com_ui_upload_new_file')}</span>
      </Button>
    </div>
  );
}
