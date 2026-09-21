export function ReaderBottomBar({ activePanel, onToggleSettings, onToggleToc }) {
  return (
    <nav className="reader-bottombar" aria-label="阅读器控制">
      <button
        type="button"
        className={`reader-bottombar-button${activePanel === 'toc' ? ' is-active' : ''}`}
        onClick={onToggleToc}
      >
        <span className="reader-bb-icon reader-bb-icon-toc" aria-hidden="true" />
        目录
      </button>
      <button
        type="button"
        className={`reader-bottombar-button${activePanel === 'settings' ? ' is-active' : ''}`}
        onClick={onToggleSettings}
      >
        <span className="reader-bb-icon reader-bb-icon-aa" aria-hidden="true">Aa</span>
        设置
      </button>
    </nav>
  );
}
