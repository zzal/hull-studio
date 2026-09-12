// A catalog rule the blueprint's content breaks: a sizing value out of range,
// a resolution or an instance class the catalog does not know. Callers report
// it to the developer; any other error is a bug.
export class CatalogError extends Error {
  override readonly name = "CatalogError";
}

// "X is not a <noun> of <scope>; <nouns> are a, b", the blueprint's diagnostic
// style, so every message says what is allowed.
export function notAmong(value: string, noun: string, scope: string, allowed: readonly string[]): string {
  return `"${value}" is not a ${noun} of ${scope}; ${noun}s are ${allowed.join(", ")}`;
}
