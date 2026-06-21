/**
 * Image attachment handling for multimodal chat.
 *
 * Validates user-selected images and prepares them for both rendering (a data
 * URL preview) and inference (a raw ArrayBuffer for wllama's mmproj path). Large
 * images are downscaled to keep memory and inference cost reasonable on the
 * target hardware (12th-gen i5 + Iris Xe).
 */

export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
/** Longest-edge cap; larger images are downscaled before encoding. */
export const MAX_IMAGE_DIM = 1024;

/** Image ready to render (dataUrl) and to send to the LLM (data: ArrayBuffer). */
export interface AttachedImage {
  id: string;
  dataUrl: string;
  mimeType: string;
  fileName: string;
  width: number;
  height: number;
  data: ArrayBuffer;
}

export interface ImageValidation {
  valid: boolean;
  error?: string;
}

/**
 * Validate a file as an attachable image. Pure and synchronous.
 */
export function validateImageFile(
  file: File,
  opts: { maxBytes?: number; allowed?: readonly string[] } = {}
): ImageValidation {
  const allowed = opts.allowed ?? SUPPORTED_IMAGE_TYPES;
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;

  if (!allowed.includes(file.type)) {
    return {
      valid: false,
      error: `Unsupported image type "${file.type || 'unknown'}". Use PNG, JPEG, WebP, or GIF.`,
    };
  }
  if (file.size > maxBytes) {
    const mb = (maxBytes / 1024 / 1024).toFixed(0);
    return { valid: false, error: `Image is too large (max ${mb} MB).` };
  }
  if (file.size === 0) {
    return { valid: false, error: 'Image file is empty.' };
  }
  return { valid: true };
}

/** Compute downscaled dimensions preserving aspect ratio. */
export function fitWithin(
  width: number,
  height: number,
  maxDim: number
): { width: number; height: number } {
  if (width <= maxDim && height <= maxDim) return { width, height };
  const scale = maxDim / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `img-${Date.now()}-${idCounter}`;
}

/**
 * Decode, (optionally) downscale, and encode an image File into an AttachedImage.
 * Browser-only (uses createImageBitmap + canvas). Throws on decode failure.
 */
export async function prepareImage(file: File, maxDim: number = MAX_IMAGE_DIM): Promise<AttachedImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxDim);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(bitmap, 0, 0, width, height);

    // Re-encode. PNG preserves UI screenshots crisply; JPEG for photos.
    const outType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob: Blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Image encoding failed'))),
        outType,
        outType === 'image/jpeg' ? 0.9 : undefined
      );
    });

    const data = await blob.arrayBuffer();
    const dataUrl = await blobToDataUrl(blob);

    return {
      id: nextId(),
      dataUrl,
      mimeType: outType,
      fileName: file.name || 'image',
      width,
      height,
      data,
    };
  } finally {
    bitmap.close();
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
    reader.readAsDataURL(blob);
  });
}
