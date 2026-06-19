import { useChannel, SOURCES_DEFAULTS } from '../../store';
import { DONATE_BOT_NAMES } from '../../services/twitch';
import { useTranslation } from '../../i18n';
import { SettingsSection } from './SettingsSection';
import { Toggle } from './Toggle';
import { EditableField } from './EditableField';
import { SOURCE_ICONS, SOURCE_LABEL_KEYS, type SourceType } from './source-icons';
import { ExtraRow } from './ExtraRow';
import { DEFAULT_EXTRAS_CONFIG, type RequestExtraType } from '@filadbd/shared';

const ENABLED_EXTRAS: RequestExtraType[] = ['build'];

const TIER_LABEL_KEYS: Record<1 | 2 | 3, 'sources.tier1' | 'sources.tier2' | 'sources.tier3'> = {
  1: 'sources.tier1',
  2: 'sources.tier2',
  3: 'sources.tier3',
};

const SOURCES: SourceType[] = ['donation', 'chat', 'resub'];

export function SourcesSection() {
  const { t } = useTranslation();
  const { useSources, canControlConnection } = useChannel();
  const {
    enabled, chatCommand, chatTiers, minDonation, extrasConfig,
    setEnabled, setChatCommand, setChatTiers, setMinDonation, setExtrasConfig,
  } = useSources();
  const readOnly = !canControlConnection;

  const getMinTier = (): 1 | 2 | 3 => {
    const min = chatTiers.length === 0 ? 1 : Math.min(...chatTiers);
    return (min >= 1 && min <= 3 ? min : 1) as 1 | 2 | 3;
  };
  const setMinTier = (minTier: number) => setChatTiers([1, 2, 3].filter(tier => tier >= minTier));

  return (
    <SettingsSection title={t('settings.section.sources')}>
      {SOURCES.map((source) => {
        const isEnabled = enabled[source];
        return (
          <div
            key={source}
            className={`source-row ${isEnabled ? 'enabled' : 'disabled'}`}
            data-source={source}
          >
            <div className="source-row-header">
              <span className="source-row-icon">{SOURCE_ICONS[source]}</span>
              <span className="source-row-name">{t(SOURCE_LABEL_KEYS[source])}</span>
              <Toggle
                checked={isEnabled}
                onClick={() => !readOnly && setEnabled({ ...enabled, [source]: !isEnabled })}
                disabled={readOnly}
                aria-label={t(SOURCE_LABEL_KEYS[source])}
              />
            </div>

            {source === 'donation' && (
              <>
                <p
                  className="source-row-desc"
                  dangerouslySetInnerHTML={{
                    __html: t('sources.donationDesc', { botNames: Array.from(DONATE_BOT_NAMES).join(', ') }),
                  }}
                />
                <div className="source-row-config">
                  <EditableField
                    label={t('sources.minimum')}
                    displayValue={`R$ ${minDonation}`}
                    disabled={readOnly}
                  >
                    <div className="settings-field-prefix">
                      <span>R$</span>
                      <input
                        id="donation-min"
                        name="donation-min"
                        type="number"
                        defaultValue={minDonation}
                        min={0}
                        step={1}
                        onBlur={e => !readOnly && setMinDonation(parseFloat(e.target.value) || 0)}
                        disabled={readOnly}
                      />
                    </div>
                  </EditableField>
                </div>
                <div className="source-row-extras">
                  {ENABLED_EXTRAS.map(extra => {
                    const cfg = extrasConfig?.[extra] ?? DEFAULT_EXTRAS_CONFIG[extra]!;
                    return (
                      <ExtraRow
                        key={extra}
                        extra={extra}
                        config={cfg}
                        minDonation={minDonation}
                        readOnly={readOnly}
                        onChange={(next) => setExtrasConfig({ ...(extrasConfig ?? {}), [extra]: next })}
                      />
                    );
                  })}
                </div>
              </>
            )}

            {source === 'chat' && (
              <>
                <p
                  className="source-row-desc"
                  dangerouslySetInnerHTML={{ __html: t('sources.chatDesc', { example: '!fila huntress' }) }}
                />
                <div className="source-row-config">
                  <EditableField
                    label={t('sources.command')}
                    displayValue={chatCommand}
                    disabled={readOnly}
                  >
                    <input
                      id="chat-command"
                      name="chat-command"
                      type="text"
                      defaultValue={chatCommand}
                      placeholder={SOURCES_DEFAULTS.chatCommand}
                      onBlur={e => !readOnly && setChatCommand(e.target.value.trim() || SOURCES_DEFAULTS.chatCommand)}
                      disabled={readOnly}
                    />
                  </EditableField>
                  <EditableField
                    label={t('sources.minTier')}
                    displayValue={t(TIER_LABEL_KEYS[getMinTier()])}
                    disabled={readOnly}
                  >
                    <select
                      id="chat-tier"
                      name="chat-tier"
                      value={getMinTier()}
                      onChange={e => !readOnly && setMinTier(Number(e.target.value))}
                      disabled={readOnly}
                    >
                      <option value={1}>{t('sources.tier1')}</option>
                      <option value={2}>{t('sources.tier2')}</option>
                      <option value={3}>{t('sources.tier3')}</option>
                    </select>
                  </EditableField>
                </div>
              </>
            )}

            {source === 'resub' && (
              <p className="source-row-desc">{t('sources.resubDesc')}</p>
            )}
          </div>
        );
      })}
    </SettingsSection>
  );
}
