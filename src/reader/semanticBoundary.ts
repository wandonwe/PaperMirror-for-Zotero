/** Only explicit section evidence is a hard barrier. Ordinary continuation is
 * deliberately unknown: capitalization alone is not evidence of a byline. */
export function semanticBoundary(before: string, after: string): boolean {
 const heading = /^(?:guideline writing group|writing (?:committee|group)|(?:peer )?review(?:er|ing)? (?:committee|group)|references|acknowledg(?:e)?ments|author contributions|disclosures|supplemental material)\b/i;
 const credentials = /\b(?:MD|PhD|MBBS|FAHA|FACC)\b/;
 const a=before.trim(),b=after.trim();
 if (heading.test(b) || /^(?:guideline writing group|writing (?:committee|group)|(?:peer )?review(?:er|ing)? (?:committee|group)|references|acknowledg(?:e)?ments|author contributions|disclosures|supplemental material)[:.]?$/i.test(a)) return true;
 // An endorsement sentence followed by a credentialed author list is not prose continuation.
 if (/^endorsed by\b/i.test(a) && /[.!?]$/.test(a) && credentials.test(b)) return true;
 return false;
}
