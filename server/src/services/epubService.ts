/**
 * Reading metadata and a cover out of an EPUB file.
 *
 * `epub2` parses the OPF package with xml2js, so a metadata value can arrive as
 * a string, as an array of nodes, or as a `{ '#': value }` node. Everything read
 * here is therefore `unknown` until `cleanText` has looked at it.
 */
import { EPub } from 'epub2';
import { isRecord } from '@lan-reader/shared';

const coverNamePattern = /(^|[-_/\\])(front[-_ ]?)?cover([._/-]|$)/i;

/**
 * The parsed metadata, as far as this module reads it.
 *
 * `epub2` types every metadata value loosely, and the unparsed nodes are kept
 * behind a symbol key, so the fields are minimal and untyped on purpose.
 */
interface EpubMetadataSource {
  title?: unknown;
  creator?: unknown;
  creatorFileAs?: unknown;
  description?: unknown;
  publisher?: unknown;
  language?: unknown;
  ISBN?: unknown;
  UUID?: unknown;
  identifier?: unknown;
  cover?: unknown;
}

/** A manifest entry, as far as cover detection reads it. */
interface EpubManifestItem {
  'media-type'?: string;
  mediaType?: string;
  properties?: string;
  property?: string;
  href?: string;
}

/** Metadata after normalisation: the shape a Book row is built from. */
export interface EpubMetadata {
  title: string | null;
  author: string | null;
  description: string | null;
  publisher: string | null;
  language: string | null;
  identifier: string | null;
}

/** A cover image that was actually found, with bytes to store. */
export interface EpubCoverImage {
  data: Buffer;
  mimeType: string | undefined;
}

export interface EpubDetails {
  metadata: EpubMetadata;
  coverImage: EpubCoverImage | null;
}

function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
}

function cleanMetadataNode(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = cleanMetadataNode(item);

      if (text) {
        return text;
      }
    }

    return null;
  }

  if (isRecord(value)) {
    return cleanText(value['#']);
  }

  return cleanText(value);
}

function rawMetadataNode(rawMetadata: unknown, key: string): unknown {
  return isRecord(rawMetadata) ? rawMetadata[key] : undefined;
}

function rawIdentifier(metadata: EpubMetadataSource): string | null {
  // The unparsed metadata hangs off `EPub.SYMBOL_RAW_DATA`. No object type can
  // be indexed with a plain `symbol`, so the same property is read reflectively.
  const rawMetadata: unknown = Reflect.get(metadata, EPub.SYMBOL_RAW_DATA);
  return (
    cleanMetadataNode(rawMetadataNode(rawMetadata, 'identifier')) ||
    cleanMetadataNode(rawMetadataNode(rawMetadata, 'dc:identifier'))
  );
}

export function normalizeEpubMetadata(metadata: EpubMetadataSource = {}): EpubMetadata {
  return {
    title: cleanText(metadata.title),
    author: cleanText(metadata.creator) || cleanText(metadata.creatorFileAs),
    description: cleanText(metadata.description),
    publisher: cleanText(metadata.publisher),
    language: cleanText(metadata.language),
    identifier:
      cleanText(metadata.ISBN) ||
      cleanText(metadata.UUID) ||
      cleanText(metadata.identifier) ||
      rawIdentifier(metadata),
  };
}

function imageMimeType(manifestItem: EpubManifestItem = {}): string | null {
  return cleanText(manifestItem['media-type'] || manifestItem.mediaType);
}

function isImageManifestItem(manifestItem: EpubManifestItem): boolean | undefined {
  return imageMimeType(manifestItem)?.toLowerCase().startsWith('image/');
}

function addCandidate(candidateIds: string[], id: unknown): void {
  const cleanId = cleanText(id);

  if (cleanId && !candidateIds.includes(cleanId)) {
    candidateIds.push(cleanId);
  }
}

function coverCandidateIds(epub: EPub): string[] {
  const candidateIds: string[] = [];
  const manifest: Record<string, EpubManifestItem> = epub.manifest || {};

  addCandidate(candidateIds, epub.metadata?.cover);

  for (const [id, item] of Object.entries(manifest)) {
    if (!isImageManifestItem(item)) {
      continue;
    }

    const properties = cleanText(item.properties || item.property);

    if (properties?.split(/\s+/).includes('cover-image')) {
      addCandidate(candidateIds, id);
    }
  }

  for (const [id, item] of Object.entries(manifest)) {
    if (!isImageManifestItem(item)) {
      continue;
    }

    if (coverNamePattern.test(id) || coverNamePattern.test(item.href || '')) {
      addCandidate(candidateIds, id);
    }
  }

  return candidateIds;
}

interface EpubImageResult {
  data: Buffer | undefined;
  mimeType: string | undefined;
}

function readEpubImage(epub: EPub, imageId: string): Promise<EpubImageResult> {
  return new Promise((resolve, reject) => {
    epub.getImage(imageId, (err, data, mimeType) => {
      if (err) {
        reject(err);
        return;
      }

      resolve({
        data,
        mimeType,
      });
    });
  });
}

export async function extractEpubCoverImage(epub: EPub): Promise<EpubCoverImage | null> {
  for (const imageId of coverCandidateIds(epub)) {
    try {
      const { data, mimeType } = await readEpubImage(epub, imageId);

      if (data?.length) {
        return { data, mimeType };
      }
    } catch {
      // Try the next likely cover entry.
    }
  }

  return null;
}

export async function parseEpubDetails(filePath: string): Promise<EpubDetails> {
  // `epub2` types `createAsync` through bluebird, which ships no declarations;
  // the annotation keeps the parsed book typed instead of implicitly `any`.
  const epub: EPub = await EPub.createAsync(filePath);

  return {
    metadata: normalizeEpubMetadata(epub.metadata),
    coverImage: await extractEpubCoverImage(epub),
  };
}

export async function parseEpubMetadata(filePath: string): Promise<EpubMetadata> {
  const { metadata } = await parseEpubDetails(filePath);
  return metadata;
}
