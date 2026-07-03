// Normalize whatever the user pastes into a bare hostname the backend accepts:
// strip scheme, any path/query, a trailing slash, surrounding space, and lowercase.
export function cleanDomain(input: string): string {
  return input
    .trim()
    .replace(/^[a-z]+:\/\//i, "") // scheme
    .replace(/\/.*$/, "") // path/query/fragment
    .replace(/\.$/, "") // trailing dot
    .toLowerCase();
}
