// Photos in chat (PLAN-20 M3): shrink and re-encode in the browser before upload, so a 12 MP phone
// photo becomes a ~200 KB JPEG. agent-service checks and re-encodes it again; this just keeps the
// upload small. Drawing on a canvas also drops the file's metadata (location) and applies its
// rotation.

export const MAX_EDGE = 1568; // matches agent-service IMAGE_LONG_EDGE
export const MAX_UPLOAD_BYTES = 1_500_000; // agent-service IMAGE_MAX_BYTES
const MAX_FILE_BYTES = 30_000_000; // bigger files aren't worth decoding
const QUALITIES = [0.85, 0.7, 0.55];

export interface PhotoUpload {
  mediaType: 'image/jpeg';
  /** Base64, no data: prefix. */
  data: string;
}

export interface Photo extends PhotoUpload {
  /** Object URL of the re-encoded JPEG, for the preview and the sent bubble. Not saved. */
  url: string;
}

/** Why a photo was refused, as an i18n key. */
export type PhotoProblem = 'errPhotoRead' | 'errPhotoTooBig';

export class PhotoError extends Error {
  constructor(readonly problem: PhotoProblem) {
    super(problem);
  }
}

/** The size that fits inside `max` × `max` without enlarging or distorting. */
export function fitSize(width: number, height: number, max = MAX_EDGE): [number, number] {
  const scale = Math.min(1, max / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

export interface Codec {
  decode(file: Blob): Promise<{ width: number; height: number; source: CanvasImageSource }>;
  encode(source: CanvasImageSource, width: number, height: number, quality: number): Promise<Blob>;
}

export const browserCodec: Codec = {
  async decode(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { width: bitmap.width, height: bitmap.height, source: bitmap };
  },
  encode(source, width, height, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.reject(new Error('no canvas'));
    ctx.fillStyle = '#fff'; // transparent PNGs get a white background, not black
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', quality),
    );
  },
};

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function preparePhoto(file: Blob, codec: Codec = browserCodec): Promise<Photo> {
  if (!file.type.startsWith('image/')) throw new PhotoError('errPhotoRead');
  if (file.size > MAX_FILE_BYTES) throw new PhotoError('errPhotoTooBig');
  let decoded: Awaited<ReturnType<Codec['decode']>>;
  try {
    decoded = await codec.decode(file);
  } catch {
    throw new PhotoError('errPhotoRead');
  }
  const [width, height] = fitSize(decoded.width, decoded.height);
  try {
    for (const quality of QUALITIES) {
      let jpeg: Blob;
      try {
        jpeg = await codec.encode(decoded.source, width, height, quality);
      } catch {
        throw new PhotoError('errPhotoRead');
      }
      if (jpeg.size <= MAX_UPLOAD_BYTES) {
        return { mediaType: 'image/jpeg', data: await base64(jpeg), url: URL.createObjectURL(jpeg) };
      }
    }
    throw new PhotoError('errPhotoTooBig');
  } finally {
    (decoded.source as { close?: () => void }).close?.(); // free the decoded bitmap
  }
}
