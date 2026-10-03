/**
 * The app has exactly one owner, and a couple of corners of the UI wink at him.
 * Gmail ignores dots and everything after a `+` in the local part, so every
 * alias of the owner's address has to resolve to the same person.
 */
const OWNER_LOCAL = 'davidmendelovits';
const OWNER_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

export function isOwnerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const [local, domain, ...rest] = email.trim().toLowerCase().split('@');
  if (rest.length > 0 || !local || !domain) return false;
  if (!OWNER_DOMAINS.has(domain)) return false;
  return (local.split('+')[0] ?? '').replace(/\./g, '') === OWNER_LOCAL;
}
