/**
 * Turns free text into a safe Postgres tsquery with prefix matching ("log fix" -> "log:* & fix:*").
 * Only letters and digits survive, so user input can never inject tsquery operators (which would
 * otherwise cause syntax errors, i.e. a 500 from a stray "(" or "&").
 * Returns null when there is nothing searchable, so callers skip the filter instead of matching nothing.
 */
export function toTsQuery(input: string): string | null {
  const terms = input.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!terms || terms.length === 0) return null;
  return terms.slice(0, 8).map((t) => `${t}:*`).join(' & ');
}
