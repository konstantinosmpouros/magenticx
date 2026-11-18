/**
 * Find in document: how many times the query occurs in the text, for the
 * find bar's count. The highlighting itself is Plate's find-replace
 * decoration (`findPlugin` in `editorKit.ts`), which matches the same way:
 * case-insensitive, within one block.
 */
import { NodeApi, type Value } from "platejs";

export function countMatches(value: Value, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  let count = 0;
  for (const block of value) {
    const haystack = NodeApi.string(block).toLowerCase();
    for (
      let at = haystack.indexOf(needle);
      at >= 0;
      at = haystack.indexOf(needle, at + needle.length)
    )
      count += 1;
  }
  return count;
}
