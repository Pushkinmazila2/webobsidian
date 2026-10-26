import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { getSettings, updateSettings } from './settings.js';
import { config } from '../config.js';
import { getUserStore, type User } from '../db/index.js';

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;

/** Mật khẩu mặc định khi cài đặt — dùng được ngay, không cần bước setup. */
export const DEFAULT_PASSWORD = '123456';
export const MIN_PASSWORD_LEN = 6;

/** So sánh chuỗi an toàn về timing (cho override pass dạng plaintext). */
function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** scrypt$<saltHex>$<hashHex> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Người dùng đã xác thực của một request (từ token phiên). */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  isAdmin: boolean;
  mustChangePassword: boolean;
  sessionId: string;
}

export const toAuthUser = (u: User, sessionId: string): AuthUser => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName || u.username,
  email: u.email,
  isAdmin: u.isAdmin,
  mustChangePassword: u.mustChangePassword,
  sessionId,
});

/** Tên tài khoản quản trị tạo sẵn khi nâng cấp từ bản một người dùng. */
export const BOOTSTRAP_ADMIN = 'admin';

/**
 * Lần chạy đầu (chưa có người dùng nào): tạo quản trị viên `admin` từ mật khẩu cũ
 * của bản một người dùng (`auth.userPasswordHash`) hoặc mật khẩu mặc định 123456
 * (bắt đổi ở lần đăng nhập đầu). Idempotent.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  const store = getUserStore();
  if ((await store.countUsers()) > 0) return;
  const s = await getSettings();
  const legacy = s.auth.userPasswordHash;
  await store.createUser({
    username: BOOTSTRAP_ADMIN,
    displayName: 'Administrator',
    isAdmin: true,
    passwordHash: legacy || (await hashPassword(DEFAULT_PASSWORD)),
    mustChangePassword: !legacy,
  });
  console.log(`[auth] created administrator "${BOOTSTRAP_ADMIN}"${legacy ? ' (password carried over)' : ` (default password ${DEFAULT_PASSWORD} — must be changed)`}`);
}

/**
 * Kiểm tra đăng nhập. `username` bỏ trống = đăng nhập kiểu cũ chỉ bằng mật khẩu
 * (chủ sở hữu). Mật khẩu khôi phục (`auth.passwordHash` hoặc WEBOBSIDIAN_PASSWORD) luôn
 * đăng nhập được vào tài khoản chủ sở hữu — quản trị viên cũ nhất còn bật.
 */
export async function loginWithPassword(username: string | undefined, password: string): Promise<User | null> {
  const store = getUserStore();
  const s = await getSettings();
  const owner = await store.getOwner();
  const name = username?.trim();
  const user = name ? await store.getUserByUsername(name) : owner;
  if (!user || user.disabled) {
    // Equalise timing a little for unknown names.
    await hashPassword(password).catch(() => {});
    return null;
  }
  if (user.passwordHash && (await verifyPassword(password, user.passwordHash))) return user;
  if (owner && user.id === owner.id) {
    if (s.auth.passwordHash && (await verifyPassword(password, s.auth.passwordHash))) return user;
    if (config.initialPassword && safeEqualStr(password, config.initialPassword)) return user;
  }
  return null;
}

/** Luôn true: hệ thống luôn có mật khẩu đăng nhập hiệu dụng. Giữ cho `/auth/status`. */
export async function isPasswordSet(): Promise<boolean> {
  return true;
}

/** Chủ sở hữu còn dùng mật khẩu mặc định? (UI bắt đổi). */
export async function ownerMustChangePassword(): Promise<boolean> {
  return Boolean((await getUserStore().getOwner())?.mustChangePassword);
}

/** Đặt mật khẩu mới cho người dùng (hash + bỏ cờ bắt đổi). */
export async function setPasswordFor(userId: string, password: string): Promise<void> {
  if (password.length < MIN_PASSWORD_LEN) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
  const store = getUserStore();
  const user = await store.getUser(userId);
  if (!user) throw new Error('User not found');
  const hash = await hashPassword(password);
  await store.updateUser(userId, { passwordHash: hash, mustChangePassword: false });
  // The settings screen still reports "default password in use" from here.
  if ((await store.getOwner())?.id === userId) {
    await updateSettings((d) => {
      d.auth.userPasswordHash = hash;
    });
  }
}

/** Đổi mật khẩu: xác minh mật khẩu hiện tại rồi lưu mật khẩu mới; các phiên khác bị thu hồi. */
export async function changePassword(userId: string, current: string, next: string, keepSessionId?: string): Promise<void> {
  const store = getUserStore();
  const user = await store.getUser(userId);
  if (!user || !user.passwordHash || !(await verifyPassword(current, user.passwordHash))) {
    throw new Error('Current password is incorrect');
  }
  await setPasswordFor(userId, next);
  await store.revokeUserSessions(userId, keepSessionId);
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

/** Tạo phiên (bản ghi trong DB) và token JWT mang `sub` = id người dùng, `sid` = id phiên. */
export async function startSession(user: User, meta: { userAgent?: string | null; ip?: string | null } = {}): Promise<{ token: string; sessionId: string }> {
  const store = getUserStore();
  const session = await store.createSession({ userId: user.id, ttlMs: SESSION_TTL_MS, ...meta });
  await store.touchLogin(user.id);
  const s = await getSettings();
  const token = jwt.sign({ sub: user.id, sid: session.id }, s.auth.jwtSecret, {
    expiresIn: Math.floor(SESSION_TTL_MS / 1000),
    algorithm: 'HS256',
  });
  return { token, sessionId: session.id };
}

/**
 * Xác minh token phiên. Ngoài chữ ký HS256 hợp lệ, phiên phải còn trong DB (chưa
 * thu hồi/hết hạn) và người dùng chưa bị vô hiệu hoá — nên thu hồi có hiệu lực ngay.
 * Token khác ký bằng cùng `jwtSecret` (unlock-cookie của share, `sub: 'share'`) và
 * token một-người-dùng cũ (`sub: 'owner'`) bị từ chối.
 */
export async function authenticateToken(token: string): Promise<AuthUser | null> {
  try {
    const s = await getSettings();
    const p = jwt.verify(token, s.auth.jwtSecret, { algorithms: ['HS256'] });
    if (typeof p !== 'object' || p === null || typeof p.sub !== 'string' || typeof p.sid !== 'string') return null;
    const store = getUserStore();
    const session = await store.getSession(p.sid);
    if (!session || session.userId !== p.sub || session.revokedAt || Date.parse(session.expiresAt) <= Date.now()) return null;
    const user = await store.getUser(p.sub);
    if (!user || user.disabled) return null;
    return toAuthUser(user, session.id);
  } catch {
    return null;
  }
}

export async function verifyToken(token: string): Promise<boolean> {
  return (await authenticateToken(token)) !== null;
}

/** ---- API keys ----------------------------------------------------------- */

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Returns { raw, record-fields }. `raw` is shown to the user exactly once. */
export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `wok_${randomBytes(24).toString('base64url')}`;
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) };
}
