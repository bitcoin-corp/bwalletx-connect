import { describe, expect, it } from 'vitest';
import { IdentityLinkConflictError, linkIdentity, signInOrLink } from '../src/link';

const K = '02' + 'ab'.repeat(32);
function db(init: Record<string, string> = {}) {
  const links = new Map(Object.entries(init));
  return {
    links,
    findUserByIdentityKey: (k: string) => links.get(k) ?? null,
    attach: (u: string, k: string) => void links.set(k, u),
  };
}

describe('linkIdentity', () => {
  it('links a new key (normalised to lowercase), then reports already-linked', async () => {
    const d = db();
    expect(await linkIdentity('u1', K.toUpperCase(), d)).toMatchObject({ status: 'linked', identityKey: K });
    expect(await linkIdentity('u1', K, d)).toMatchObject({ status: 'already-linked' });
  });

  it('refuses a key linked to another user and leaves the link alone', async () => {
    const d = db({ [K]: 'u2' });
    const e = await linkIdentity('u1', K, d).catch((x) => x);
    expect(e).toBeInstanceOf(IdentityLinkConflictError);
    expect(e.code).toBe('IDENTITY_LINKED_TO_OTHER_USER');
    expect(e.otherUserId).toBe('u2');
    expect(d.links.get(K)).toBe('u2');
  });

  it('rejects a bad key', async () => {
    await expect(linkIdentity('u1', 'nope', db())).rejects.toThrow(/identityKey/);
  });
});

describe('signInOrLink', () => {
  it('signs in a known key, creates or reports unknown ones, links for a signed-in user', async () => {
    expect(await signInOrLink(K, db({ [K]: 'u9' }))).toMatchObject({ status: 'signed-in', userId: 'u9' });
    expect(await signInOrLink(K, db())).toMatchObject({ status: 'unknown', userId: null });
    const d = db();
    expect(await signInOrLink(K, { ...d, createUser: () => 'new1' })).toMatchObject({ status: 'created', userId: 'new1' });
    expect(d.links.get(K)).toBe('new1');
    expect(await signInOrLink(K, { ...db(), currentUserId: 'hc-user' })).toMatchObject({ status: 'linked', userId: 'hc-user' });
    await expect(signInOrLink(K, { ...db({ [K]: 'other' }), currentUserId: 'hc-user' })).rejects.toBeInstanceOf(IdentityLinkConflictError);
  });
});
