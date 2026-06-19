import { useTranslation } from '../../i18n';
import { Toggle } from './Toggle';
import { EditableField } from './EditableField';
import type { RequestExtraType, ExtraConfig } from '@filadbd/shared';

interface Props {
  extra: RequestExtraType;
  config: ExtraConfig;
  minDonation: number;
  readOnly: boolean;
  onChange: (config: ExtraConfig) => void;
}

const LABEL_KEYS: Record<RequestExtraType, { name: 'extras.build.name'; desc: 'extras.build.desc' }> = {
  build: { name: 'extras.build.name', desc: 'extras.build.desc' },
};

export function ExtraRow({ extra, config, minDonation, readOnly, onChange }: Props) {
  const { t } = useTranslation();
  const keys = LABEL_KEYS[extra];

  return (
    <div className={`extra-row ${config.enabled ? 'enabled' : 'disabled'}`} data-extra={extra}>
      <div className="extra-row-header">
        <span className="extra-row-name">{t(keys.name)}</span>
        <Toggle
          checked={config.enabled}
          onClick={() => !readOnly && onChange({ ...config, enabled: !config.enabled })}
          disabled={readOnly}
          aria-label={t(keys.name)}
        />
      </div>
      <p className="extra-row-desc">{t(keys.desc)}</p>
      <div className="extra-row-config">
        <EditableField
          label={t('sources.minimum')}
          displayValue={`R$ ${config.price}`}
          disabled={readOnly}
        >
          <div className="settings-field-prefix">
            <span>R$</span>
            <input
              id={`extra-${extra}-price`}
              name={`extra-${extra}-price`}
              type="number"
              defaultValue={config.price}
              min={minDonation}
              step={1}
              onBlur={e => {
                if (readOnly) return;
                const parsed = parseFloat(e.target.value);
                const clamped = Math.max(minDonation, Number.isFinite(parsed) ? parsed : minDonation);
                onChange({ ...config, price: clamped });
                e.target.value = String(clamped);
              }}
              disabled={readOnly}
            />
          </div>
        </EditableField>
      </div>
    </div>
  );
}
