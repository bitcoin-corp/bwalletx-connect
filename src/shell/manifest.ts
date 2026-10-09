/**
 * bApp manifest: /.well-known/bapp.json. One file declares the app's five scoped slots, its drawer
 * (Home + sections) and its like-to-fund config. The web bar draws from it; inside bWalletX the
 * wallet's native dock reads the same file. Every path is same-origin: no URLs, no schemes.
 */

export const SLOT_IDS = ['wallet', 'exchange', 'b', 'feed', 'chat'] as const;
export type SlotId = (typeof SLOT_IDS)[number];

export interface BappSlot {
  /** Same-origin path, e.g. "/feed". Required when enabled, except for "b" (the agent). */
  path?: string;
  /** Optional rename ("Market"); the icon and position never change. */
  label?: string;
  /** false = shown greyed out and not clickable. Slots are never hidden. */
  enabled: boolean;
}

export interface BappDrawerItem {
  label: string;
  path: string;
  /** Optional same-origin icon path. */
  icon?: string;
}

export interface BappLikeConfig {
  /** Which fields of a feed item hold the id, token (BSV-21 id / $TICKER), payee, title and media. */
  fields: { id: string; token: string; payee?: string; title?: string; media?: string };
  /** Price of one Like in US cents. Default 1 (one PNEE). */
  amountCents: number;
  /** Pay in PNEE (the wallet's USD-cent token) when held, else BSV. Default "PNEE". */
  currency: 'PNEE' | 'BSV';
  /** Daily cap in US cents. Default 100 ($1), never more. */
  dailyCapCents: number;
}

export interface BappTheme {
  /** Active/accent colour, #RRGGBB. Default #FFD24D. */
  accent?: string;
}

/** v2 wide layout: a section of the bApp, drawn by the wallet as a column next to its sidebar. */
export interface BappSection {
  /** Stable id, [a-z0-9-], max 24. Sent in bapp:navigate / bapp:active. */
  id: string;
  label: string;
  /** Same-origin path. */
  path: string;
  /** Named icon (e.g. "home", "spark", "grid", "chat") or a same-origin path. */
  icon?: string;
}

export const PANES = ['single', 'list-detail', 'three-pane'] as const;
export type BappPanes = (typeof PANES)[number];

export interface BappWide {
  sidebar?: { label?: string; icon?: string; badge?: 'live' | number };
  /** If omitted, the wide shell maps the v1 slots to sections (see wideSections). */
  sections?: BappSection[];
  panes: BappPanes;
  /** Below this frame width the wallet uses the phone layout. Default 720. */
  minWidth: number;
}

export const WIDE_MIN_WIDTH_DEFAULT = 720;
export const SECTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

export interface BappManifest {
  version: 1;
  name: string;
  /** Same-origin path to a square icon. */
  icon: string;
  /** The app's Home (first drawer item). Default "/". */
  home: string;
  theme?: BappTheme;
  slots: Record<SlotId, BappSlot>;
  drawer: BappDrawerItem[];
  like?: BappLikeConfig;
  /** v2: wide (desktop / wide web) layout. */
  wide?: BappWide;
}

export type ValidationResult =
  | { ok: true; manifest: BappManifest; errors: [] }
  | { ok: false; errors: string[]; manifest?: undefined };

export const WELL_KNOWN_PATH = '/.well-known/bapp.json';
export const LIKE_DEFAULT_CENTS = 1;
export const LIKE_MAX_DAILY_CENTS = 100;

/**
 * A same-origin path: starts with one "/", no "//" (protocol-relative), no backslashes, no control
 * characters, no scheme. Query and hash are allowed.
 */
export function isSameOriginPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) return false;
  if (p[0] !== '/' || p[1] === '/' || p[1] === '\\') return false;
  if (/[\\\u0000-\u001f\u007f\s]/.test(p)) return false;
  // Resolving against a dummy origin must not change origin.
  try {
    return new URL(p, 'https://bapp.invalid').origin === 'https://bapp.invalid';
  } catch {
    return false;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 64): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** Validate and normalise a parsed bapp.json. Never throws. */
export function validateManifest(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['manifest must be a JSON object'] };
  const m = input;
  const known = new Set(['$schema', 'version', 'name', 'icon', 'home', 'theme', 'slots', 'drawer', 'like', 'wide']);
  for (const k of Object.keys(m)) if (!known.has(k)) errors.push(`unknown field "${k}"`);

  if (m.version !== 1) errors.push('version must be 1');
  if (!str(m.name, 40)) errors.push('name must be a non-empty string (max 40)');
  if (!isSameOriginPath(m.icon)) errors.push('icon must be a same-origin path starting with "/"');
  const home = m.home === undefined ? '/' : m.home;
  if (!isSameOriginPath(home)) errors.push('home must be a same-origin path starting with "/"');

  let theme: BappTheme | undefined;
  if (m.theme !== undefined) {
    if (!isObj(m.theme)) errors.push('theme must be an object');
    else {
      for (const k of Object.keys(m.theme)) if (k !== 'accent') errors.push(`unknown field "theme.${k}"`);
      if (m.theme.accent !== undefined && !(typeof m.theme.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(m.theme.accent)))
        errors.push('theme.accent must be #RRGGBB');
      theme = m.theme.accent ? { accent: m.theme.accent as string } : {};
    }
  }

  const slots = {} as Record<SlotId, BappSlot>;
  if (!isObj(m.slots)) errors.push('slots must be an object with wallet, exchange, b, feed, chat');
  else {
    for (const k of Object.keys(m.slots)) if (!(SLOT_IDS as readonly string[]).includes(k)) errors.push(`unknown slot "${k}"`);
    for (const id of SLOT_IDS) {
      const s = m.slots[id];
      if (!isObj(s)) { errors.push(`slots.${id} is required (use "enabled": false for an unused slot)`); continue; }
      for (const k of Object.keys(s)) if (!['path', 'label', 'enabled'].includes(k)) errors.push(`unknown field "slots.${id}.${k}"`);
      if (typeof s.enabled !== 'boolean') errors.push(`slots.${id}.enabled must be true or false`);
      if (s.path !== undefined && !isSameOriginPath(s.path)) errors.push(`slots.${id}.path must be a same-origin path starting with "/"`);
      if (s.enabled === true && s.path === undefined && id !== 'b') errors.push(`slots.${id}.path is required when enabled`);
      if (s.label !== undefined && !str(s.label, 12)) errors.push(`slots.${id}.label must be a short string (max 12)`);
      slots[id] = { enabled: s.enabled === true, ...(s.path !== undefined ? { path: s.path as string } : {}), ...(s.label !== undefined ? { label: s.label as string } : {}) };
    }
  }

  const drawer: BappDrawerItem[] = [];
  if (m.drawer !== undefined) {
    if (!Array.isArray(m.drawer)) errors.push('drawer must be an array');
    else if (m.drawer.length > 24) errors.push('drawer has more than 24 items');
    else m.drawer.forEach((d, i) => {
      if (!isObj(d)) { errors.push(`drawer[${i}] must be an object`); return; }
      for (const k of Object.keys(d)) if (!['label', 'path', 'icon'].includes(k)) errors.push(`unknown field "drawer[${i}].${k}"`);
      if (!str(d.label, 40)) errors.push(`drawer[${i}].label must be a non-empty string (max 40)`);
      if (!isSameOriginPath(d.path)) errors.push(`drawer[${i}].path must be a same-origin path starting with "/"`);
      if (d.icon !== undefined && !isSameOriginPath(d.icon)) errors.push(`drawer[${i}].icon must be a same-origin path starting with "/"`);
      drawer.push({ label: d.label as string, path: d.path as string, ...(d.icon ? { icon: d.icon as string } : {}) });
    });
  }

  let like: BappLikeConfig | undefined;
  if (m.like !== undefined) {
    const l = m.like;
    if (!isObj(l)) errors.push('like must be an object');
    else {
      for (const k of Object.keys(l)) if (!['fields', 'amountCents', 'currency', 'dailyCapCents'].includes(k)) errors.push(`unknown field "like.${k}"`);
      const f = l.fields;
      if (!isObj(f) || !str(f.id) || !str(f.token)) errors.push('like.fields needs "id" and "token" field names');
      else for (const k of ['payee', 'title', 'media']) if (f[k] !== undefined && !str(f[k])) errors.push(`like.fields.${k} must be a field name`);
      const amount = l.amountCents ?? LIKE_DEFAULT_CENTS;
      const cap = l.dailyCapCents ?? LIKE_MAX_DAILY_CENTS;
      const currency = l.currency ?? 'PNEE';
      if (!Number.isInteger(amount) || (amount as number) < 1) errors.push('like.amountCents must be a whole number of cents, at least 1');
      if (!Number.isInteger(cap) || (cap as number) < 1 || (cap as number) > LIKE_MAX_DAILY_CENTS) errors.push('like.dailyCapCents must be 1..100 ($1 max)');
      else if (Number.isInteger(amount) && (amount as number) > (cap as number)) errors.push('like.amountCents cannot exceed like.dailyCapCents');
      if (currency !== 'PNEE' && currency !== 'BSV') errors.push('like.currency must be "PNEE" or "BSV"');
      if (isObj(f)) {
        const fields: BappLikeConfig['fields'] = { id: f.id as string, token: f.token as string };
        for (const k of ['payee', 'title', 'media'] as const) if (typeof f[k] === 'string') fields[k] = f[k] as string;
        like = { fields, amountCents: amount as number, currency: currency as 'PNEE' | 'BSV', dailyCapCents: cap as number };
      }
    }
  }

  let wide: BappWide | undefined;
  if (m.wide !== undefined) wide = validateWide(m.wide, errors);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    manifest: {
      version: 1, name: (m.name as string).trim(), icon: m.icon as string, home: home as string,
      ...(theme ? { theme } : {}), slots, drawer, ...(like ? { like } : {}), ...(wide ? { wide } : {}),
    },
  };
}

const NAMED_ICON_RE = /^[a-z][a-z0-9-]{0,23}$/;

function validateWide(w: unknown, errors: string[]): BappWide | undefined {
  if (!isObj(w)) { errors.push('wide must be an object'); return undefined; }
  for (const k of Object.keys(w)) if (!['sidebar', 'sections', 'panes', 'minWidth'].includes(k)) errors.push(`unknown field "wide.${k}"`);
  const out: BappWide = { panes: 'single', minWidth: WIDE_MIN_WIDTH_DEFAULT };
  if (w.sidebar !== undefined) {
    const sb = w.sidebar;
    if (!isObj(sb)) errors.push('wide.sidebar must be an object');
    else {
      for (const k of Object.keys(sb)) if (!['label', 'icon', 'badge'].includes(k)) errors.push(`unknown field "wide.sidebar.${k}"`);
      if (sb.label !== undefined && !str(sb.label, 24)) errors.push('wide.sidebar.label must be a short string (max 24)');
      if (sb.icon !== undefined && !isSameOriginPath(sb.icon)) errors.push('wide.sidebar.icon must be a same-origin path starting with "/"');
      if (sb.badge !== undefined && sb.badge !== 'live' && !(Number.isInteger(sb.badge) && (sb.badge as number) >= 0))
        errors.push('wide.sidebar.badge must be "live" or a whole number');
      out.sidebar = {
        ...(sb.label !== undefined ? { label: sb.label as string } : {}),
        ...(sb.icon !== undefined ? { icon: sb.icon as string } : {}),
        ...(sb.badge !== undefined ? { badge: sb.badge as 'live' | number } : {}),
      };
    }
  }
  if (w.sections !== undefined) {
    if (!Array.isArray(w.sections)) errors.push('wide.sections must be an array');
    else if (w.sections.length === 0 || w.sections.length > 16) errors.push('wide.sections must have 1..16 items');
    else {
      const ids = new Set<string>();
      out.sections = [];
      w.sections.forEach((s, i) => {
        if (!isObj(s)) { errors.push(`wide.sections[${i}] must be an object`); return; }
        for (const k of Object.keys(s)) if (!['id', 'label', 'path', 'icon'].includes(k)) errors.push(`unknown field "wide.sections[${i}].${k}"`);
        if (typeof s.id !== 'string' || !SECTION_ID_RE.test(s.id)) errors.push(`wide.sections[${i}].id must match [a-z0-9-] (max 24)`);
        else if (ids.has(s.id)) errors.push(`wide.sections[${i}].id "${s.id}" is a duplicate`);
        else ids.add(s.id);
        if (!str(s.label, 24)) errors.push(`wide.sections[${i}].label must be a non-empty string (max 24)`);
        if (!isSameOriginPath(s.path)) errors.push(`wide.sections[${i}].path must be a same-origin path starting with "/"`);
        if (s.icon !== undefined && !(typeof s.icon === 'string' && (NAMED_ICON_RE.test(s.icon) || isSameOriginPath(s.icon))))
          errors.push(`wide.sections[${i}].icon must be an icon name or a same-origin path`);
        out.sections!.push({ id: s.id as string, label: s.label as string, path: s.path as string, ...(s.icon !== undefined ? { icon: s.icon as string } : {}) });
      });
    }
  }
  if (w.panes !== undefined) {
    if (!(PANES as readonly unknown[]).includes(w.panes)) errors.push('wide.panes must be "single", "list-detail" or "three-pane"');
    else out.panes = w.panes as BappPanes;
  }
  if (w.minWidth !== undefined) {
    if (!Number.isInteger(w.minWidth) || (w.minWidth as number) < 320 || (w.minWidth as number) > 4096) errors.push('wide.minWidth must be a whole number of px, 320..4096');
    else out.minWidth = w.minWidth as number;
  }
  return out;
}

/**
 * The sections the wide shell draws: the manifest's `wide.sections`, or, for a v1 manifest, the
 * enabled path slots (wallet, exchange, feed, chat) mapped to sections.
 */
export function wideSections(m: BappManifest): BappSection[] {
  if (m.wide?.sections?.length) return m.wide.sections;
  const icons: Record<SlotId, string> = { wallet: 'wallet', exchange: 'exchange', b: 'b', feed: 'home', chat: 'chat' };
  const labels: Record<SlotId, string> = { wallet: 'Wallet', exchange: 'Exchange', b: 'b', feed: 'Feed', chat: 'Chat' };
  return SLOT_IDS.filter((id) => id !== 'b' && m.slots[id].enabled && m.slots[id].path).map((id) => ({
    id, label: m.slots[id].label ?? labels[id], path: m.slots[id].path!, icon: icons[id],
  }));
}

/** The path for a wide section id, or null if the manifest has no such section. */
export function sectionPath(m: BappManifest, id: unknown): string | null {
  if (typeof id !== 'string') return null;
  return wideSections(m).find((s) => s.id === id)?.path ?? null;
}

/** Same as validateManifest but throws with every error listed. */
export function parseManifest(input: unknown): BappManifest {
  const r = validateManifest(input);
  if (!r.ok) throw new Error(`Invalid bapp.json:\n- ${r.errors.join('\n- ')}`);
  return r.manifest;
}

/** Fetch and validate /.well-known/bapp.json (same origin). */
export async function loadManifest(path: string = WELL_KNOWN_PATH, fetchImpl: typeof fetch = fetch): Promise<BappManifest> {
  if (!isSameOriginPath(path)) throw new Error('loadManifest: path must be same-origin');
  const res = await fetchImpl(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`loadManifest: ${path} returned ${res.status}`);
  return parseManifest(await res.json());
}

/** The path a slot points at, or null when disabled / no path. */
export function slotPath(m: BappManifest, slot: SlotId): string | null {
  const s = m.slots[slot];
  return s && s.enabled && s.path ? s.path : null;
}

export const isSlotId = (v: unknown): v is SlotId => typeof v === 'string' && (SLOT_IDS as readonly string[]).includes(v);
