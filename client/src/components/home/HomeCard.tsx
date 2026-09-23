import type { ReactNode } from 'react';
import { useId } from 'react';

interface HomeCardProps {
  /** Real header actions shown at the trailing edge (for example an edit button). */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Makes the card title a real navigation action, shown with a trailing chevron. */
  onTitleAction?: () => void;
  /** Hides the heading visually while keeping it as the card's accessible name. */
  titleHidden?: boolean;
  title: string;
  /** Accessible name of the title action when it differs from the visible title. */
  titleActionLabel?: string;
  /** Content placed right after the heading, such as a count. */
  titleSuffix?: ReactNode;
}

/** White rounded home card. Later dashboard cards reuse this frame and heading treatment. */
export function HomeCard({
  actions,
  children,
  className,
  onTitleAction,
  title,
  titleActionLabel,
  titleHidden = false,
  titleSuffix,
}: HomeCardProps) {
  const titleId = useId();

  return (
    <section
      className={className ? `home-card ${className}` : 'home-card'}
      aria-labelledby={titleId}
    >
      <div className={titleHidden && !actions ? 'home-card-header visually-hidden' : 'home-card-header'}>
        <div className="home-card-heading">
          <h2 className={titleHidden ? 'home-card-title visually-hidden' : 'home-card-title'} id={titleId}>
            {onTitleAction ? (
              <button
                className="home-card-title-button"
                type="button"
                aria-label={titleActionLabel}
                onClick={() => onTitleAction()}
              >
                <span>{title}</span>
                <span className="home-card-chevron" aria-hidden="true" />
              </button>
            ) : title}
          </h2>
          {titleSuffix}
        </div>
        {actions ? <div className="home-card-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
