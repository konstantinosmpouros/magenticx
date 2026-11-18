/**
 * A canvas document's title from its file name: `brief.md` reads as "brief".
 * The extension says nothing to the reader (every canvas document is
 * markdown); a name that is only the extension keeps it, so it never reads
 * as empty.
 */
export function documentTitle(name: string): string {
  const title = name.replace(/\.md$/i, "");
  return title || name;
}
