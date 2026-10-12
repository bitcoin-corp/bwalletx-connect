/**
 * Link a proven identity key to a user in YOUR auth system (Supabase, next-auth, your own table).
 * You supply the storage callbacks; this module only holds the rules.
 */

export interface LinkCallbacks {
  /** The user id this identity key is linked to, or null. */
  findUserByIdentityKey(identityKey: string): Promise<string | null> | string | null;
  /** Save the link. Make (identity_key) unique in your table so a race cannot double-link. */
  attach(userId: string, identityKey: string): Promise<void> | void;
}

export type LinkResult = { status: 'linked' | 'already-linked'; userId: string; identityKey: string };

export class IdentityLinkConflictError extends Error {
  readonly code = 'IDENTITY_LINKED_TO_OTHER_USER';
  constructor(
    readonly identityKey: string,
    readonly otherUserId: string,
  ) {
    super('This bWalletX identity is already linked to a different account. Sign in with that account, or unlink it there first.');
    this.name = 'IdentityLinkConflictError';
  }
}

const norm = (k: string) => {
  if (typeof k !== 'string' || !/^0[23][0-9a-fA-F]{64}$/.test(k)) throw new Error('identityKey must be a compressed public key (66 hex chars)');
  return k.toLowerCase();
};

/**
 * Link `identityKey` (already verified with verifySignIn) to the signed-in `userId`.
 * Throws IdentityLinkConflictError if it belongs to someone else. Idempotent for the same user.
 */
export async function linkIdentity(userId: string, identityKey: string, cb: LinkCallbacks): Promise<LinkResult> {
  if (!userId) throw new Error('linkIdentity needs the current user id');
  const key = norm(identityKey);
  const owner = await cb.findUserByIdentityKey(key);
  if (owner && owner !== userId) throw new IdentityLinkConflictError(key, owner);
  if (owner === userId) return { status: 'already-linked', userId, identityKey: key };
  await cb.attach(userId, key);
  return { status: 'linked', userId, identityKey: key };
}

export interface SignInOrLinkOptions extends LinkCallbacks {
  /** The user already signed in some other way (e.g. HandCash, email), if any. */
  currentUserId?: string | null;
  /** Make a new user for an unknown identity key. Without it, unknown keys return status 'unknown'. */
  createUser?(identityKey: string): Promise<string> | string;
}

export type SignInOrLinkResult =
  | { status: 'signed-in' | 'linked' | 'already-linked' | 'created'; userId: string; identityKey: string }
  | { status: 'unknown'; userId: null; identityKey: string };

/**
 * The usual verify-route logic: signed in already → link; known key → that user; else create (or report unknown).
 * Throws IdentityLinkConflictError when a signed-in user tries to link a key owned by another user.
 */
export async function signInOrLink(identityKey: string, o: SignInOrLinkOptions): Promise<SignInOrLinkResult> {
  const key = norm(identityKey);
  if (o.currentUserId) return linkIdentity(o.currentUserId, key, o);
  const owner = await o.findUserByIdentityKey(key);
  if (owner) return { status: 'signed-in', userId: owner, identityKey: key };
  if (!o.createUser) return { status: 'unknown', userId: null, identityKey: key };
  const userId = await o.createUser(key);
  await o.attach(userId, key);
  return { status: 'created', userId, identityKey: key };
}
