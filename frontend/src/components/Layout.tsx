import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();

  return (
    <div className="min-h-screen">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link to="/" className="text-lg font-semibold tracking-tight text-indigo-600">
            lookout
          </Link>

          <nav className="flex items-center gap-4 text-sm">
            <Link
              to="/"
              className={pathname === "/" ? "font-medium text-gray-900" : "text-gray-500 hover:text-gray-900"}
            >
              Dashboard
            </Link>
            {user?.role === "ADMIN" ? (
              <Link
                to="/admin/metrics"
                className={
                  pathname === "/admin/metrics"
                    ? "font-medium text-gray-900"
                    : "text-gray-500 hover:text-gray-900"
                }
              >
                Metrics
              </Link>
            ) : null}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm">
            {user ? (
              <>
                <span className="text-gray-500">{user.email}</span>
                {user.role === "ADMIN" ? (
                  <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-700">
                    admin
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={logout}
                  className="text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline"
                >
                  Log out
                </button>
              </>
            ) : null}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
