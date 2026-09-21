import type { SyntheticEvent } from 'react';
import type { Book } from '../../types/library.js';

type CoverBook = Pick<Book, 'title' | 'coverUrl' | 'coverThumbnailUrl' | 'coverThumbnail2xUrl'>;
interface BookCoverProps {
  book: CoverBook;
  disableNativeImageActions?: boolean;
  priority?: boolean;
  sizes?: string;
}

export function getBookCoverImage(book: CoverBook | null | undefined) {
  const smallUrl = book?.coverThumbnailUrl || null;
  const largeUrl = book?.coverThumbnail2xUrl || null;
  const legacyUrl = book?.coverUrl || null;
  const src = smallUrl || largeUrl || legacyUrl;
  const srcSet = [
    smallUrl ? `${smallUrl} 384w` : null,
    largeUrl ? `${largeUrl} 768w` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return {
    fallbackUrl: src !== legacyUrl ? legacyUrl : null,
    src,
    srcSet: srcSet || undefined,
  };
}

export function revealCoverImage(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.classList.add('is-loaded');
}

export function recoverLegacyCover(event: SyntheticEvent<HTMLImageElement>) {
  const image = event.currentTarget;
  const fallbackUrl = image.dataset.fallbackUrl;

  if (!fallbackUrl || image.dataset.fallbackApplied === 'true') {
    image.classList.add('is-error');
    return;
  }

  image.dataset.fallbackApplied = 'true';
  image.removeAttribute('srcset');
  image.src = fallbackUrl;
}

export function preventNativeImageDrag(event: Pick<SyntheticEvent, 'preventDefault'>) {
  event.preventDefault();
}

export function BookCover({
  book,
  disableNativeImageActions = false,
  priority = false,
  sizes = '110px',
}: BookCoverProps) {
  const image = getBookCoverImage(book);

  if (image.src) {
    return (
      <img
        className={[
          'book-cover-image',
          disableNativeImageActions ? 'is-native-image-actions-disabled' : '',
        ].filter(Boolean).join(' ')}
        src={image.src}
        srcSet={image.srcSet}
        sizes={sizes}
        alt={book.title || '书籍封面'}
        width="384"
        height="576"
        decoding="async"
        fetchPriority={priority ? 'high' : 'auto'}
        loading={priority ? 'eager' : 'lazy'}
        data-fallback-url={image.fallbackUrl || undefined}
        draggable={disableNativeImageActions ? false : undefined}
        onDragStart={disableNativeImageActions ? preventNativeImageDrag : undefined}
        onError={recoverLegacyCover}
        onLoad={revealCoverImage}
      />
    );
  }

  return (
    <div className="book-cover-placeholder">
      <span className="placeholder-spine" aria-hidden="true" />
      <span className="placeholder-mark" aria-hidden="true" />
    </div>
  );
}
