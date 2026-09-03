import type { ReactNode } from "react";
import type { UrlListItem } from "../api/types";

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-indigo-600 ${className}`}
      role="status"
      aria-label="loading"
    />
  );
}

export type DisplayStatus = "UP" | "DOWN" | "PENDING" | "PAUSED";

/** Paused wins over the last check: a paused URL is not being measured, so its
 * old result should not read as a live state. */
export function displayStatus(url: Pick<UrlListItem, "isActive" | "lastCheck">): DisplayStatus {
  if (!url.isActive) {
    return "PAUSED";
  }
  if (!url.lastCheck) {
    return "PENDING";
  }
  return url.lastCheck.status;
}

const PILL_STYLES: Record<DisplayStatus, string> = {
  UP: "bg-green-100 text-green-800 ring-green-200",
  DOWN: "bg-red-100 text-red-800 ring-red-200",
  PENDING: "bg-gray-100 text-gray-600 ring-gray-200",
  PAUSED: "bg-amber-100 text-amber-800 ring-amber-200",
};

export function StatusPill({ status }: { status: DisplayStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${PILL_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

export function Card({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{value}</div>
      {subtitle ? <div className="mt-0.5 text-xs text-gray-500">{subtitle}</div> : null}
    </div>
  );
}

export function Button({
  children,
  onClick,
  type = "button",
  variant = "secondary",
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  title?: string;
}) {
  const styles = {
    primary: "bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600",
    secondary: "bg-white text-gray-700 hover:bg-gray-50 border-gray-300",
    danger: "bg-white text-red-700 hover:bg-red-50 border-red-300",
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${styles}`}
    >
      {children}
    </button>
  );
}
