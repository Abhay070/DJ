/** Best-effort metadata recovery from a file name. */

/**
 * Split "Artist - Title" out of a file name, tolerating the usual noise:
 * leading track numbers, underscores for spaces, and hyphens that belong to
 * the title rather than the separator.
 */
export function parseFileName(name: string): { artist: string; title: string } {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const cleaned = base.replace(/^\d{1,3}[\s.\-]+/, '').trim();
  const parts = cleaned.split(/\s+-\s+/);
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return { artist: 'Unknown artist', title: cleaned || name.trim() || 'Untitled' };
}
