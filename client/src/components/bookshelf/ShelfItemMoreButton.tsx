import type { MouseEvent } from 'react';

/** The ⋯ on a card's progress row. A sibling of the card button, never its descendant. */
export function ShelfItemMoreButton({ name, onClick }: {
  name: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button className="shelf-item-more" type="button" aria-haspopup="dialog" aria-label={`更多操作：${name}`} onClick={onClick}>
      <span aria-hidden="true" />
    </button>
  );
}
