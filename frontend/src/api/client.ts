export const TOKEN_KEY = "lookout_token";

interface ValidationDetails {
  formErrors?: string[];
  fieldErrors?: Record<string, string[]>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: ValidationDetails;

  constructor(status: number, code: string, message: string, details?: ValidationDetails) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Flattens a 400 validation_error into lines suitable for inline display. */
  fieldMessages(): string[] {
    if (!this.details) {
      return [];
    }
    const fromFields = Object.entries(this.details.fieldErrors ?? {}).flatMap(([field, messages]) =>
      messages.map((message) => `${field}: ${message}`),
    );
    return [...(this.details.formErrors ?? []), ...fromFields];
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Skip the 401 redirect. Used by the first /auth/me call, which should just
   * fall back to the login screen. */
  skipAuthRedirect?: boolean;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, skipAuthRedirect } = options;
  const token = getToken();

  const response = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 401 && !skipAuthRedirect) {
    clearToken();
    if (window.location.pathname !== "/login") {
      window.location.assign("/login");
    }
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const asRecord = (payload ?? {}) as {
      error?: string;
      message?: string;
      details?: ValidationDetails;
    };
    throw new ApiError(
      response.status,
      asRecord.error ?? "error",
      asRecord.message ?? asRecord.error ?? `Request failed with status ${response.status}`,
      asRecord.details,
    );
  }

  return payload as T;
}
