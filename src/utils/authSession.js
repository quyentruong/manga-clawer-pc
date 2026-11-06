import { hasApp } from './packageEntitlements';

/**
 * Hạn mức token tải thử (Supabase):
 * - User type được đọc từ Supabase membership.
 * - User mới chưa có membership sẽ được tự tạo profile Free và cấp credit.
 */
/** UI progress-bar max; server grant must match resolve-user-profile + SQL (300). */
export const FREE_USER_TOKEN_MAX = 300;

export function hasAppSession(_session) {
  return true;
}

export function isFreeUserTokenTierSession(_session) {
  return false;
}

/** Quản trị — toàn quyền ứng dụng; chỉ role này ghim/sửa/xóa tin chat (xác thực tại main process). */
export function isAdminSession(session) {
  if (session?.isAdmin === true) return true;
  return String(session?.userType || '').trim().toLowerCase() === 'admin';
}

/** userType từ Supabase membership: Admin > Member > Free. */
export function isMemberSession(session) {
  const userType = String(session?.userType || '').trim().toLowerCase();
  return (
    userType === 'member' ||
    userType === 'premium member' ||
    userType === 'super member' ||
    userType === 'admin'
  );
}
