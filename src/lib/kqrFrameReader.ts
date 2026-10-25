// Only loaded through a dynamic import from the scanner, so jsQR stays out of the main bundle.
import jsQR from 'jsqr';

export function kqrDecodeRgba(data: Uint8ClampedArray, width: number, height: number): string | null {
  try {
    return jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data ?? null;
  } catch {
    return null;
  }
}

export function createFrameDetector(): { detect(src: CanvasImageSource): Promise<Array<{ rawValue?: string }>> } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    async detect(src) {
      if (!ctx) return [];
      const width = 'videoWidth' in src ? src.videoWidth : 'width' in src ? Number(src.width) : 0;
      const height = 'videoHeight' in src ? src.videoHeight : 'height' in src ? Number(src.height) : 0;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
      const scale = Math.min(1, 800 / Math.max(width, height));
      const targetWidth = Math.max(1, Math.floor(width * scale));
      const targetHeight = Math.max(1, Math.floor(height * scale));
      if (canvas.width !== targetWidth) canvas.width = targetWidth;
      if (canvas.height !== targetHeight) canvas.height = targetHeight;
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const rawValue = kqrDecodeRgba(frame.data, canvas.width, canvas.height);
      return rawValue === null ? [] : [{ rawValue }];
    },
  };
}
