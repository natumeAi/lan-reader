import type { ReactNode } from 'react';
import { useId } from 'react';

interface HomeCardProps {
  children: ReactNode;
  className?: string;
  /** Makes the card title a real navigation action, shown with a trailing chevron. */
  onTitleAction?: () => void;
  title: string;
  /** Accessible name of the title action when it differs from the visible title. */
  titleActionLabel?: string;
}

/** White rounded home card. Later dashboard cards reuse this frame and heading treatment. */
export function HomeCard({
  children,
  className,
  onTitleAction,
  title,
  titleActionLabel,
}: HomeCardProps) {
  const titleId = useId();

  return (
    <section
      className={className ? `home-card ${className}` : 'home-card'}
      aria-labelledby={titleId}
    >
      <div className="home-card-header">
        <h2 className="home-card-title" id={titleId}>
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
      </div>
      {children}
    </section>
  );
}
