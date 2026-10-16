import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ApiError, api, clearToken, getToken, setToken } from "../api/client";
import type { AuthResponse, User } from "../api/types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Enough retries to ride out a Render free tier cold start.
const MAX_ME_ATTEMPTS = 10;
const ME_RETRY_MS = 3000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    const loadUser = (attempt: number) => {
      api<{ user: User }>("/api/auth/me", { skipAuthRedirect: true })
        .then((data) => {
          if (!cancelled) {
            setUser(data.user);
            setLoading(false);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) {
            return;
          }
          // Only a 401 means the token is bad. Anything else is probably the api
          // waking up or a network blip, so keep the token and try again.
          if (err instanceof ApiError && err.status === 401) {
            clearToken();
            setLoading(false);
          } else if (attempt >= MAX_ME_ATTEMPTS) {
            setLoading(false);
          } else {
            timer = window.setTimeout(() => loadUser(attempt + 1), ME_RETRY_MS);
          }
        });
    };

    loadUser(1);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const authenticate = useCallback(async (path: string, email: string, password: string) => {
    const data = await api<AuthResponse>(path, { method: "POST", body: { email, password } });
    setToken(data.token);
    setUser(data.user);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      login: (email, password) => authenticate("/api/auth/login", email, password),
      signup: (email, password) => authenticate("/api/auth/signup", email, password),
      logout: () => {
        clearToken();
        setUser(null);
      },
    }),
    [user, loading, authenticate],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return context;
}

export function RequireAuth({ children, adminOnly }: { children: ReactNode; adminOnly?: boolean }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  if (adminOnly && user.role !== "ADMIN") {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
