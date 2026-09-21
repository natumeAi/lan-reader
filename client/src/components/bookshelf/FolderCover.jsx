import {
  getBookCoverImage,
  preventNativeImageDrag,
  recoverLegacyCover,
  revealCoverImage,
} from './BookCover.jsx';

export function FolderCover({ folder, disableNativeImageActions = false }) {
  const previewBooks = (folder.previewBooks || []).slice(0, 4);

  return (
    <span className="folder-cover">
      <span className="folder-preview-grid" aria-hidden="true">
        {previewBooks.map((previewBook, index) => {
          const image = getBookCoverImage(previewBook);

          return (
            <span className="folder-preview-slot" key={previewBook.id ?? index}>
              {image.src ? (
                <img
                  className={[
                    'folder-preview-image',
                    disableNativeImageActions ? 'is-native-image-actions-disabled' : '',
                  ].filter(Boolean).join(' ')}
                  src={image.src}
                  srcSet={image.srcSet}
                  sizes="64px"
                  alt=""
                  width="384"
                  height="576"
                  decoding="async"
                  fetchPriority="low"
                  loading="lazy"
                  data-fallback-url={image.fallbackUrl || undefined}
                  draggable={disableNativeImageActions ? false : undefined}
                  onDragStart={disableNativeImageActions ? preventNativeImageDrag : undefined}
                  onError={recoverLegacyCover}
                  onLoad={revealCoverImage}
                />
              ) : (
                <span className="folder-preview-image folder-preview-image-empty" />
              )}
            </span>
          );
        })}
      </span>
    </span>
  );
}
