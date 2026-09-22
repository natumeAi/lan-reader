import type { FontSettingsPanelProps } from './FontSettingsPanel.js';
import type { LayoutSetting, ThemeOption } from '../../hooks/useReaderSettings.js';
interface ReaderSettingsPanelProps extends FontSettingsPanelProps {
  diagnosticsEnabled: boolean; onStartDiagnostics: () => void; onExportDiagnostics: () => void;
  layoutSettings: LayoutSetting[]; onBackToMain: () => void; onOpenFontSettings: () => void; onThemeChange: (id: string) => void; readerTheme: ThemeOption; readerThemeId: string; settingsView: 'main' | 'font'; themeOptions: ThemeOption[];
}
import { FontSettingsPanel } from './FontSettingsPanel.js';

export function ReaderSettingsPanel({
  diagnosticsEnabled,
  onStartDiagnostics,
  onExportDiagnostics,
  fontFamilyId,
  fontFamilyOptions,
  fontSize,
  fontSizeMax,
  fontSizeMin,
  fontSizeStep,
  layoutSettings,
  onBackToMain,
  onDecreaseFontSize,
  onFontFamilyChange,
  onFontSizeChange,
  onIncreaseFontSize,
  onOpenFontSettings,
  onThemeChange,
  readerFont,
  readerTheme,
  readerThemeId,
  settingsView,
  themeOptions,
}: ReaderSettingsPanelProps) {
  return (
    <div className="reader-panel reader-panel-settings" role="dialog" aria-label="阅读设置">
      <div className="reader-panel-handle" aria-hidden="true" />
      {settingsView === 'main' ? (
        <h2 className="reader-panel-title">Aa 设置</h2>
      ) : (
        <div className="reader-panel-subheader">
          <button
            type="button"
            className="reader-panel-back-button"
            onClick={onBackToMain}
            aria-label="返回 Aa 设置"
          >
            <span aria-hidden="true">‹</span>
          </button>
          <h2 className="reader-panel-title reader-panel-subtitle">字体</h2>
        </div>
      )}
      <div className="reader-settings-content">
        {settingsView === 'main' ? (
          <>
            <section className="reader-settings-group" aria-labelledby="reader-text-settings-title">
              <h3 id="reader-text-settings-title" className="reader-settings-group-title">文字</h3>
              <button
                type="button"
                className="reader-settings-menu-item"
                onClick={onOpenFontSettings}
              >
                <span className="reader-settings-label">字体</span>
                <span className="reader-settings-menu-meta">
                  <span className="reader-settings-value">{readerFont.label} / {fontSize}号</span>
                  <span className="reader-settings-chevron" aria-hidden="true">›</span>
                </span>
              </button>
            </section>
            <section className="reader-settings-group" aria-label="阅读问题反馈">
              <button className="reader-settings-menu-item" onClick={diagnosticsEnabled ? onExportDiagnostics : onStartDiagnostics}>
                {diagnosticsEnabled ? '导出阅读诊断' : '记录阅读问题'}
              </button>
              <p className="reader-settings-value">{diagnosticsEnabled ? '复现后导出；文件包含阅读位置和少量可见文字，仅保存在本机。' : '记录本次阅读的翻页和位置变化，帮助排查卡顿或续读问题。'}</p>
            </section>

            <section className="reader-settings-group" aria-labelledby="reader-layout-settings-title">
              <h3 id="reader-layout-settings-title" className="reader-settings-group-title">排版</h3>
              {layoutSettings.map((setting) => (
                <ReaderRangeSetting
                  key={setting.id}
                  id={setting.id}
                  label={setting.label}
                  value={setting.value}
                  valueLabel={setting.valueLabel}
                  min={setting.min}
                  max={setting.max}
                  step={setting.step}
                  onChange={setting.onChange}
                />
              ))}
            </section>

            <section className="reader-settings-group" aria-labelledby="reader-appearance-settings-title">
              <h3 id="reader-appearance-settings-title" className="reader-settings-group-title">外观</h3>
              <div className="reader-settings-section" aria-labelledby="reader-theme-title">
                <div className="reader-settings-row">
                  <span id="reader-theme-title" className="reader-settings-label">主题</span>
                  <span className="reader-settings-value">{readerTheme.label}</span>
                </div>
                <div className="reader-theme-options" role="group" aria-labelledby="reader-theme-title">
                  {themeOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`reader-theme-option${readerThemeId === option.id ? ' is-active' : ''}`}
                      onClick={() => onThemeChange(option.id)}
                      aria-pressed={readerThemeId === option.id}
                    >
                      <span
                        className="reader-theme-swatch"
                        style={{
                          backgroundColor: option.swatch,
                          color: option.text,
                        }}
                        aria-hidden="true"
                      />
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </section>
          </>
        ) : (
          <FontSettingsPanel
            fontFamilyId={fontFamilyId}
            fontFamilyOptions={fontFamilyOptions}
            fontSize={fontSize}
            fontSizeMax={fontSizeMax}
            fontSizeMin={fontSizeMin}
            fontSizeStep={fontSizeStep}
            onDecreaseFontSize={onDecreaseFontSize}
            onFontFamilyChange={onFontFamilyChange}
            onFontSizeChange={onFontSizeChange}
            onIncreaseFontSize={onIncreaseFontSize}
            readerFont={readerFont}
          />
        )}
      </div>
    </div>
  );
}

function ReaderRangeSetting({ id, label, value, valueLabel, min, max, step, onChange }: LayoutSetting) {
  return (
    <div className="reader-settings-section" aria-labelledby={id}>
      <div className="reader-settings-row">
        <span id={id} className="reader-settings-label">{label}</span>
        <span className="reader-settings-value">{valueLabel}</span>
      </div>
      <input
        className="reader-setting-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onChange}
        aria-labelledby={id}
        aria-valuetext={valueLabel}
      />
    </div>
  );
}
