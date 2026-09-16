import type { WsAttachment } from '@/types/api';

/**
 * How an attachment is rendered in the preview popup. Trusted exactly as far
 * as these four modes — anything else falls back to a download-only card.
 */
export type AttachmentPreviewKind = 'image' | 'markdown' | 'html' | 'text';

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'];
const MARKDOWN_EXTS = ['md', 'markdown'];
const HTML_EXTS = ['html', 'htm', 'xhtml'];
const TEXT_EXTS = [
  'txt', 'log', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini',
  'rs', 'ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'sh', 'bash', 'zsh',
  'css', 'scss', 'sql', 'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'swift',
];

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Resolve the preview mode for an attachment, or `null` when it is not
 * previewable (download only). MIME is authoritative; the filename extension
 * is a fallback for tools that reported a generic content type.
 */
export function attachmentPreviewKind(
  attachment: Pick<WsAttachment, 'mime' | 'filename'>,
): AttachmentPreviewKind | null {
  const mime = (attachment.mime || '').toLowerCase();
  const ext = extensionOf(attachment.filename);

  if (mime.startsWith('image/') || IMAGE_EXTS.includes(ext)) return 'image';
  if (mime === 'text/markdown' || MARKDOWN_EXTS.includes(ext)) return 'markdown';
  if (mime === 'text/html' || mime === 'application/xhtml+xml' || HTML_EXTS.includes(ext)) {
    return 'html';
  }
  if (mime.startsWith('text/') || TEXT_EXTS.includes(ext)) return 'text';
  return null;
}

/** Human-readable byte size (e.g. `1.2 MB`). */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
