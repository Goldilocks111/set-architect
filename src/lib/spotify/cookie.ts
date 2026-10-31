import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'spotify_session';
export const STATE_COOKIE = 'spotify_oauth_state';

const DEV_FALLBACK = 'set-architect-dev-only-cookie-secret';

/** Key source: SPOTIFY_COOKIE_SECRET, else SPOTIFY_CLIENT_SECRET, else a fixed dev value (refused in production). */
function key(): Buffer {
  const secret = process.env.SPOTIFY_COOKIE_SECRET || process.env.SPOTIFY_CLIENT_SECRET;
  if (!secret && process.env.NODE_ENV === 'production')
    throw new Error('SPOTIFY_COOKIE_SECRET is required in production');
  return createHash('sha256')
    .update(secret || DEV_FALLBACK)
    .digest();
}

/** AES-256-GCM; output is base64url(iv | tag | ciphertext). */
export function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}

export function open<T>(sealed: string | undefined): T | null {
  if (!sealed) return null;
  try {
    const buf = Buffer.from(sealed, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function setCookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export const clearCookieHeader = (name: string) => setCookieHeader(name, '', 0);
