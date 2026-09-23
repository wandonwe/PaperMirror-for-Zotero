/** Reject evident cross-reference substitutions without guessing semantic similarity. */
export function referenceAlignmentIssue(source: string, translated: string): string | null {
 // Require an author-list-shaped opening, not a numbered list or a decimal.
 const opening = /^\s*(\d{1,3})[.)．]\s*([A-Z][A-Za-z’'-]+(?:\s+[A-Z]{1,4})?)\s*[,，]/u;
 const s = source.match(opening), t = translated.match(opening);
 if (!t) return null;
 if (!s) return 'reference-unexpected-entry';
 if (Number(s[1]) !== Number(t[1])) return 'reference-number-mismatch';
 // Only compare retained Latin author names. Localized names are not guessed.
 const surname = (name: string) => name.replace(/\s+[A-Z]{1,4}$/, '').toLowerCase();
 if (surname(s[2]!) !== surname(t[2]!)) return 'reference-author-mismatch';
 return null;
}
