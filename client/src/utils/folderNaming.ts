import { MAX_FOLDER_NAME_LENGTH } from '@lan-reader/shared';

const trailingSeparators = /[\s\p{P}\p{Z}]+$/u;
const trailingVolume = /(?:第?[0-9一二三四五六七八九十百零〇两]+[卷册部集话篇章]?|第|\bvol\.?\s*\d*|[上中下前后]篇?卷?)$/iu;

/** Suggest a series name within the server's UTF-16 length limit, without splitting graphemes. */
export function suggestFolderName(titleA: string, titleB: string): string | null {
  const first = Array.from(titleA.normalize('NFKC'));
  const second = Array.from(titleB.normalize('NFKC'));
  let length = 0;
  while (length < first.length && first[length] === second[length]) length += 1;
  let prefix = first.slice(0, length).join('');

  // Without a grapheme segmenter, keep short suggestions intact and decline to truncate:
  // a code-point slice could split a combining sequence or joined emoji.
  if (prefix.length > MAX_FOLDER_NAME_LENGTH) {
    if (typeof Intl.Segmenter !== 'function') return null;
    let bounded = '';
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(prefix)) {
      if (bounded.length + segment.length > MAX_FOLDER_NAME_LENGTH) break;
      bounded += segment;
    }
    prefix = bounded;
  }

  // Trimming punctuation may expose another suffix (for example "Series Vol. ").
  let previous: string;
  do {
    previous = prefix;
    prefix = prefix.replace(trailingSeparators, '').replace(trailingVolume, '');
  } while (prefix !== previous);
  prefix = prefix.trim();

  const characters = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(prefix))
    : Array.from(prefix);
  return characters.length >= 2 ? prefix : null;
}
