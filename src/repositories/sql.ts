/** "$1, $2, ..." for an IN list, starting after `offset` existing params. */
export function placeholders(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, i) => `$${i + 1 + offset}`).join(", ");
}

/** "($1, $2, $3), ($4, $5, $6), ..." for a multi-row INSERT. */
export function rowPlaceholders(rows: number, columns: number): string {
  return Array.from({ length: rows }, (_, r) => `(${placeholders(columns, r * columns)})`).join(", ");
}

/** Matches are stored with the smaller UUID first so each pair has exactly one row. */
export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
