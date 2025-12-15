import { useLocalize } from '~/hooks';

export default function ActiveSetting() {
  const localize = useLocalize();
  return (
    <div className="text-token-text-tertiary space-x-2 overflow-hidden text-ellipsis text-sm font-light">
      {localize('com_ui_talking_to')} {/* eslint-disable-next-line i18next/no-literal-string */}
      <span className="text-token-text-secondary font-medium">[latest] Tailwind CSS GPT</span>
    </div>
  );
}
