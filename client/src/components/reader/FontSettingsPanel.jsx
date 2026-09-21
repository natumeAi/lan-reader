export function FontSettingsPanel({
  fontFamilyId,
  fontFamilyOptions,
  fontSize,
  fontSizeMax,
  fontSizeMin,
  fontSizeStep,
  onDecreaseFontSize,
  onFontFamilyChange,
  onFontSizeChange,
  onIncreaseFontSize,
  readerFont,
}) {
  return (
    <section className="reader-settings-group reader-settings-font-panel" aria-labelledby="reader-font-settings-title">
      <h3 id="reader-font-settings-title" className="reader-settings-group-title">字号</h3>
      <div className="reader-settings-section" aria-labelledby="reader-font-size-title">
        <div className="reader-settings-row">
          <span id="reader-font-size-title" className="reader-settings-label">大小</span>
          <span className="reader-settings-value">{fontSize}号</span>
        </div>
        <div className="reader-font-size-control">
          <button
            type="button"
            className="reader-font-step"
            onClick={onDecreaseFontSize}
            disabled={fontSize <= fontSizeMin}
            aria-label="减小字号"
          >
            A
          </button>
          <input
            className="reader-setting-slider"
            type="range"
            min={fontSizeMin}
            max={fontSizeMax}
            step={fontSizeStep}
            value={fontSize}
            onChange={onFontSizeChange}
            aria-labelledby="reader-font-size-title"
            aria-valuetext={`${fontSize}号`}
          />
          <button
            type="button"
            className="reader-font-step reader-font-step-large"
            onClick={onIncreaseFontSize}
            disabled={fontSize >= fontSizeMax}
            aria-label="增大字号"
          >
            A
          </button>
        </div>
      </div>

      <div className="reader-settings-section" aria-labelledby="reader-font-family-title">
        <div className="reader-settings-row">
          <span id="reader-font-family-title" className="reader-settings-label">字体</span>
          <span className="reader-settings-value">{readerFont.label}</span>
        </div>
        <div className="reader-font-options" role="group" aria-labelledby="reader-font-family-title">
          {fontFamilyOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`reader-font-option${fontFamilyId === option.id ? ' is-active' : ''}`}
              style={{ fontFamily: option.value }}
              onClick={() => onFontFamilyChange(option.id)}
              aria-pressed={fontFamilyId === option.id}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
