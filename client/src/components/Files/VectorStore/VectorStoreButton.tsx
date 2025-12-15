import React from 'react';
import { PlusIcon } from 'lucide-react';
import { Button } from '@librechat/client';
import { useLocalize } from '~/hooks';

type VectorStoreButtonProps = {
  onClick: () => void;
};

export default function VectorStoreButton({ onClick }: VectorStoreButtonProps) {
  const localize = useLocalize();
  return (
    <div className="w-full">
      <Button className="w-full bg-black p-0 text-white" onClick={onClick}>
        <PlusIcon className="h-4 w-4 font-bold" />
        &nbsp; <span className="text-nowrap">{localize('com_ui_add_store')}</span>
      </Button>
    </div>
  );
}
