import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { hasAppSession } from '../utils/authSession';

const AuthContext = createContext(null);

const DEFAULT_UNLOCKED_SESSION = {
  email: 'local@offline',
  userType: 'Member',
  entitlements: [{ packageKey: 'app', expiresAt: null }],
  isAdmin: false,
  impliedSupabaseFree: false,
  refreshToken: 'local-bypass-token',
};

function ensureUnlockedAuthSession(session) {
  if (!session || typeof session !== 'object') {
    return DEFAULT_UNLOCKED_SESSION;
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

export function AuthProvider({ children, onEnteredApp }) {
  const [authInvalidReason, setAuthInvalidReason] = useState(null);
  /** Chờ lần đọc phiên đầu tiên (Electron). */
  const [authBootstrapped, setAuthBootstrapped] = useState(true);
  /** Phiên OAuth — mặc định luôn mở khóa. */
  const [authSession, setAuthSessionState] = useState(() => ensureUnlockedAuthSession(null));
  const [freeUserRemainingTokens, setFreeUserRemainingTokens] = useState(null);
  const [freeUserTokenExhaustedOpen, setFreeUserTokenExhaustedOpen] = useState(false);

  const setAuthSession = useCallback((nextSession) => {
    setAuthSessionState((prev) => {
      const resolved = typeof nextSession === 'function' ? nextSession(prev) : nextSession;
      return ensureUnlockedAuthSession(resolved);
    });
  }, []);

  const isSignedIn = true;
  const shouldConsumeFreeUserToken = false;

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.getAuthSession) {
      setAuthSessionState(ensureUnlockedAuthSession(null));
      setAuthBootstrapped(true);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const s = await api.getAuthSession();
        if (!cancelled) setAuthSessionState(ensureUnlockedAuthSession(s));
      } catch {
        if (!cancelled) setAuthSessionState(ensureUnlockedAuthSession(null));
      } finally {
        if (!cancelled) setAuthBootstrapped(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!authBootstrapped || !api?.ensureFreeUserCreditsByEmail) return;
    if (!shouldConsumeFreeUserToken) {
      setFreeUserRemainingTokens(null);
      return;
    }
    const email = String(authSession?.email || '').trim();
    if (!email) {
      setFreeUserRemainingTokens(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await api.ensureFreeUserCreditsByEmail({
          email,
          userType: authSession?.userType,
          impliedSupabaseFree: authSession?.impliedSupabaseFree,
        });
        if (cancelled) return;
        if (r?.ok) {
          setFreeUserRemainingTokens(
            Number.isFinite(Number(r.remainingTokens)) ? Math.max(0, Math.floor(Number(r.remainingTokens))) : 0
          );
        } else {
          setFreeUserRemainingTokens(null);
        }
      } catch {
        if (!cancelled) setFreeUserRemainingTokens(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authBootstrapped, authSession, shouldConsumeFreeUserToken]);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.subscribeAuthSessionInvalidated) return undefined;
    const unsub = api.subscribeAuthSessionInvalidated((payload) => {
      // Bỏ qua việc vô hiệu hóa phiên ở chế độ bypass
    });
    return () => unsub?.();
  }, []);

  const handleAuthGateLoggedIn = useCallback(async () => {
    setAuthInvalidReason(null);
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.getAuthSession) {
      onEnteredApp?.();
      return;
    }
    try {
      const s = await api.getAuthSession();
      setAuthSessionState(ensureUnlockedAuthSession(s));
    } catch {
      setAuthSessionState(ensureUnlockedAuthSession(null));
    }
    onEnteredApp?.();
  }, [onEnteredApp]);

  const value = useMemo(
    () => ({
      authBootstrapped,
      authSession,
      setAuthSession,
      authInvalidReason,
      setAuthInvalidReason,
      isSignedIn,
      freeUserRemainingTokens,
      setFreeUserRemainingTokens,
      freeUserTokenExhaustedOpen,
      setFreeUserTokenExhaustedOpen,
      shouldConsumeFreeUserToken,
      handleAuthGateLoggedIn,
    }),
    [
      authBootstrapped,
      authSession,
      authInvalidReason,
      isSignedIn,
      freeUserRemainingTokens,
      freeUserTokenExhaustedOpen,
      shouldConsumeFreeUserToken,
      handleAuthGateLoggedIn,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
