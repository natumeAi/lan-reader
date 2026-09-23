import type { MainView } from '../../utils/mainViewPreference.js';
import { MAIN_VIEW } from '../../utils/mainViewPreference.js';

interface MainNavigationProps {
  activeView: MainView;
  onSelectView: (view: MainView) => void;
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <path
        d="M3.5 10.6 12 3.8l8.5 6.8V20a.9.9 0 0 1-.9.9h-4.9v-6.2H9.3v6.2H4.4a.9.9 0 0 1-.9-.9Z"
        fill="currentColor"
      />
    </svg>
  );
}

function ShelfIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <path
        d="M12 6.4C10.2 5 7.6 4.4 3.5 4.6v13.7c4.1-.2 6.7.4 8.5 1.8m0-13.7c1.8-1.4 4.4-2 8.5-1.8v13.7c-4.1-.2-6.7.4-8.5 1.8m0-13.7v13.7"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.9"
      />
    </svg>
  );
}

const destinations = [
  { view: MAIN_VIEW.HOME, label: '首页', Icon: HomeIcon },
  { view: MAIN_VIEW.SHELF, label: '书架', Icon: ShelfIcon },
] as const;

/** Bottom tab bar for the two main views. Selection is local state, not browser history. */
export function MainNavigation({ activeView, onSelectView }: MainNavigationProps) {
  return (
    <nav className="main-navigation" aria-label="主导航">
      {destinations.map(({ view, label, Icon }) => {
        const active = view === activeView;
        return (
          <button
            key={view}
            className={active ? 'main-navigation-item is-active' : 'main-navigation-item'}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => onSelectView(view)}
          >
            <Icon />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
