const { app, ipcMain, shell } = require('electron');
const googleAuth = require('../lib/auth/googleAuthService');
const supabaseGuestCredits = require('../lib/auth/supabaseGuestCredits');

const DEFAULT_UNLOCKED_SESSION = {
  email: 'local@offline',
  userType: 'Member',
  entitlements: [{ packageKey: 'app', expiresAt: null }],
  isAdmin: false,
  impliedSupabaseFree: false,
  refreshToken: 'local-bypass-token',
};

function ensureUnlockedSession(session) {
  if (!session || typeof session !== 'object') {
    return { ...DEFAULT_UNLOCKED_SESSION };
  }
  return {
    ...DEFAULT_UNLOCKED_SESSION,
    ...session,
    userType:
      !session.userType || String(session.userType).trim().toLowerCase() === 'free'
        ? 'Member'
        : session.userType,
    entitlements:
      Array.isArray(session.entitlements) && session.entitlements.length > 0
        ? session.entitlements
        : [{ packageKey: 'app', expiresAt: null }],
    impliedSupabaseFree: false,
    refreshToken: session.refreshToken || 'local-bypass-token',
  };
}

function registerAuthIpc(ipc_context) {
  ipcMain.handle('auth:getSession', async () => {
    const session = await googleAuth.getSessionEnriched(app.getPath('userData'));
    return ensureUnlockedSession(session);
  });

  ipcMain.handle('auth:loginGoogle', async () => {
    return googleAuth.loginWithGoogle(shell, {
      userDataPath: app.getPath('userData'),
      clearOAuth: false,
    });
  });

  ipcMain.handle('auth:logout', () => googleAuth.logout(app.getPath('userData')));

  ipcMain.handle('trial:ensureFreeUserCreditsByEmail', async () => {
    return { ok: true, skipped: true, reason: 'MEMBER_BYPASS' };
  });

  ipcMain.handle('trial:consumeFreeUserDownloadCredit', async () => {
    return { ok: true, skipped: true, reason: 'MEMBER_BYPASS' };
  });
}

module.exports = { registerAuthIpc };
