export type Role = "USER" | "ADMIN";
export type CheckStatus = "UP" | "DOWN";
export type ErrorType =
  | "TIMEOUT"
  | "DNS_FAIL"
  | "CONN_REFUSED"
  | "INVALID_URL"
  | "HTTP_ERROR"
  | "TLS_ERROR"
  | "UNKNOWN";

export interface User {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
}

export interface Check {
  // BigInt on the backend, serialized as a string.
  id: string;
  urlId: string;
  status: CheckStatus;
  statusCode: number | null;
  responseMs: number | null;
  errorType: ErrorType | null;
  errorMessage: string | null;
  checkedAt: string;
}

export interface Url {
  id: string;
  userId: string;
  url: string;
  intervalSeconds: number;
  isActive: boolean;
  createdAt: string;
}

export interface UrlListItem extends Url {
  lastCheck: Check | null;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface BulkImportResult {
  created: Url[];
  skipped: { url: string; reason: string }[];
}

export type StatsWindow = "24h" | "7d" | "30d";

export interface SeriesPoint {
  t: string;
  totalChecks: number;
  failures: number;
  avgMs: number | null;
  p95Ms: number | null;
}

export interface UrlStats {
  window: StatsWindow;
  totalChecks: number;
  failures: number;
  uptimePct: number | null;
  avgMs: number | null;
  p95Ms: number | null;
  series: SeriesPoint[];
}

export interface Summary {
  totalUrls: number;
  activeUrls: number;
  up: number;
  down: number;
  pending: number;
  uptimePct24h: number | null;
  failures24h: number;
  avgMs24h: number | null;
}

export interface Metrics {
  checks: {
    lastHour: {
      total: number;
      failures: number;
      failureRate: number | null;
      avgMs: number | null;
      p95Ms: number | null;
    };
    perMinute: number;
  };
  queue: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
  process: {
    uptimeSec: number;
    rssMb: number;
    heapUsedMb: number;
  };
  timestamp: string;
}

export interface AuthResponse {
  user: User;
  token: string;
}

/** POST /api/urls/:id/check returns the finished check, or a job id if the
 * worker did not finish within the API's wait window. */
export type ManualCheckResponse = { check: Check } | { jobId: string; message: string };
