import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Media, MediaKind, Store } from './store.js';
import type { MediaAttachment, SendResult, WhatsAppClient } from './whatsapp/client.js';

const MB = 1024 * 1024;

/** File types WhatsApp accepts, with its size limits. */
export const MEDIA_TYPES: Record<string, { kind: MediaKind; maxBytes: number; ext: string[] }> = {
  'image/jpeg': { kind: 'image', maxBytes: 5 * MB, ext: ['.jpg', '.jpeg'] },
  'image/png': { kind: 'image', maxBytes: 5 * MB, ext: ['.png'] },
  'video/mp4': { kind: 'video', maxBytes: 16 * MB, ext: ['.mp4'] },
  'video/3gpp': { kind: 'video', maxBytes: 16 * MB, ext: ['.3gp'] },
  'application/pdf': { kind: 'document', maxBytes: 100 * MB, ext: ['.pdf'] },
  'application/msword': { kind: 'document', maxBytes: 100 * MB, ext: ['.doc'] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'document', maxBytes: 100 * MB, ext: ['.docx'] },
  'application/vnd.ms-excel': { kind: 'document', maxBytes: 100 * MB, ext: ['.xls'] },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'document', maxBytes: 100 * MB, ext: ['.xlsx'] },
  'application/vnd.ms-powerpoint': { kind: 'document', maxBytes: 100 * MB, ext: ['.ppt'] },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'document', maxBytes: 100 * MB, ext: ['.pptx'] },
  'text/plain': { kind: 'document', maxBytes: 100 * MB, ext: ['.txt'] },
};
export const MAX_UPLOAD_BYTES = 100 * MB;

/** WhatsApp keeps uploaded media for 30 days; re-upload a little before that. */
const REUPLOAD_AFTER_MS = 25 * 24 * 60 * 60 * 1000;
/** Longest caption WhatsApp shows under an image, video or document. */
export const MAX_CAPTION = 1024;

export class MediaError extends Error {}

/** Works out the file type from the browser's Content-Type, falling back to the file extension. */
export function detectMimeType(contentType: string | undefined, filename: string): string | null {
  const declared = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (MEDIA_TYPES[declared]) return declared;
  const ext = extname(filename).toLowerCase();
  return Object.keys(MEDIA_TYPES).find((type) => MEDIA_TYPES[type].ext.includes(ext)) ?? null;
}

export function cleanFilename(name: string): string {
  const cleaned = basename(name.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f"<>|]/g, '')
    .trim()
    .slice(0, 200);
  return cleaned || 'file';
}

export class MediaLibrary {
  private readonly uploads = new Map<number, Promise<MediaAttachment>>();

  constructor(
    private readonly store: Store,
    private readonly client: WhatsAppClient,
    private readonly dir: string,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  async save(data: Uint8Array, rawFilename: string, contentType: string | undefined, now: number): Promise<Media> {
    const filename = cleanFilename(rawFilename);
    const mimeType = detectMimeType(contentType, filename);
    if (!mimeType) {
      throw new MediaError('WhatsApp accepts JPG/PNG images, MP4 videos, and PDF, Word, Excel, PowerPoint or text documents');
    }
    const { kind, maxBytes } = MEDIA_TYPES[mimeType];
    if (data.byteLength === 0) throw new MediaError('The file is empty');
    if (data.byteLength > maxBytes) {
      throw new MediaError(`WhatsApp limits ${kind}s to ${maxBytes / MB} MB; this file is ${(data.byteLength / MB).toFixed(1)} MB`);
    }
    const storagePath = join(this.dir, `${now}-${randomUUID()}${extname(filename).toLowerCase()}`);
    await writeFile(storagePath, data);
    return this.store.createMedia({ filename, mimeType, size: data.byteLength, kind, storagePath }, now);
  }

  read(media: Media): Promise<Buffer> {
    return readFile(media.storagePath);
  }

  async remove(id: number): Promise<'deleted' | 'in_use' | 'missing'> {
    const media = this.store.getMedia(id);
    const result = this.store.deleteMedia(id);
    if (result === 'deleted' && media) await unlink(media.storagePath).catch(() => {});
    return result;
  }

  /** The file as a WhatsApp attachment, uploading it first if WhatsApp doesn't have a fresh copy. */
  attachment(mediaId: number, now: number): Promise<MediaAttachment> {
    const media = this.store.getMedia(mediaId);
    if (!media) return Promise.reject(new MediaError('The attached file was deleted'));
    if (media.waMediaId && media.waUploadedAt && now - media.waUploadedAt < REUPLOAD_AFTER_MS) {
      return Promise.resolve({ kind: media.kind, id: media.waMediaId, filename: media.filename });
    }
    // Share one upload between everyone being sent the same file at the same moment.
    let pending = this.uploads.get(mediaId);
    if (!pending) {
      pending = (async () => {
        const id = await this.client.uploadMedia(await this.read(media), media.mimeType, media.filename);
        this.store.setWhatsAppMediaId(mediaId, id, now);
        return { kind: media.kind, id, filename: media.filename };
      })().finally(() => this.uploads.delete(mediaId));
      this.uploads.set(mediaId, pending);
    }
    return pending;
  }
}

/**
 * Sends text with an optional attachment. Short text becomes the attachment's caption;
 * longer text follows as its own message. Returns the id of the first message sent.
 */
export async function sendRich(
  client: WhatsAppClient,
  to: string,
  text: string,
  attachment?: MediaAttachment,
): Promise<SendResult> {
  if (!attachment) return client.sendText(to, text);
  if (text.length <= MAX_CAPTION) return client.sendMedia(to, attachment, text || undefined);
  const first = await client.sendMedia(to, attachment);
  await client.sendText(to, text);
  return first;
}
