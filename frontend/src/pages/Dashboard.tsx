import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type {
  BulkImportResult,
  ManualCheckResponse,
  Paginated,
  Summary,
  Url,
  UrlListItem,
} from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../components/Toast";
import { Button, Card, Spinner, StatusPill, displayStatus } from "../components/ui";
import { usePolling } from "../hooks/usePolling";
import { formatSeconds, relativeTime } from "../utils/time";

const PAGE_SIZE = 20;
const SAMPLE_URLS = [
  "https://www.google.com",
  "https://www.github.com",
  "https://en.wikipedia.org/saecs/Saweascasce",
];
const INTERVAL_OPTIONS = [60, 300, 900, 1800, 3600];

export function Dashboard() {
  const { user } = useAuth();
  const { notify } = useToast();

  const [page, setPage] = useState(1);
  const [showAll, setShowAll] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [newInterval, setNewInterval] = useState(300);
  const [submitting, setSubmitting] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  // Rows updated by "Check now" are overlaid on the polled list so a fresh
  // result is visible immediately instead of after the next poll.
  const [rowOverrides, setRowOverrides] = useState<Record<string, UrlListItem>>({});

  const allParam = showAll && user?.role === "ADMIN" ? "&all=true" : "";

  const summary = usePolling<Summary>(
    () => api<Summary>(`/api/dashboard/summary?${allParam.slice(1)}`),
    5000,
    [allParam],
  );

  const list = usePolling<Paginated<UrlListItem>>(
    () => api<Paginated<UrlListItem>>(`/api/urls?page=${page}&pageSize=${PAGE_SIZE}${allParam}`),
    5000,
    [page, allParam],
  );

  const reload = useCallback(() => {
    setRowOverrides({});
    list.refresh();
    summary.refresh();
  }, [list, summary]);

  const onAdd = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const { url } = await api<{ url: Url }>("/api/urls", {
        method: "POST",
        body: { url: newUrl, intervalSeconds: newInterval },
      });
      notify("success", `Added ${url.url}`);
      setNewUrl("");
      reload();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "Could not add URL");
    } finally {
      setSubmitting(false);
    }
  };

  const onCheckNow = async (id: string) => {
    setBusyRow(id);
    try {
      const result = await api<ManualCheckResponse>(`/api/urls/${id}/check`, { method: "POST" });
      if ("check" in result) {
        const row = rows.find((item) => item.id === id);
        if (row) {
          setRowOverrides((current) => ({ ...current, [id]: { ...row, lastCheck: result.check } }));
        }
        notify("success", `Checked: ${result.check.status}`);
      } else {
        notify("success", result.message === "queued" ? "Check queued" : result.message);
      }
      summary.refresh();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "Check failed");
    } finally {
      setBusyRow(null);
    }
  };

  const onToggleActive = async (row: UrlListItem) => {
    try {
      await api(`/api/urls/${row.id}`, { method: "PATCH", body: { isActive: !row.isActive } });
      notify("success", row.isActive ? "Paused" : "Resumed");
      reload();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "Update failed");
    }
  };

  const onDelete = async (row: UrlListItem) => {
    if (!window.confirm(`Delete ${row.url}? Its check history will be removed too.`)) {
      return;
    }
    try {
      await api(`/api/urls/${row.id}`, { method: "DELETE" });
      notify("success", "Deleted");
      reload();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "Delete failed");
    }
  };

  const onCheckAll = async () => {
    try {
      const result = await api<{ enqueued: number }>("/api/urls/check-all", { method: "POST" });
      notify("success", `queued ${result.enqueued} checks`);
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "Could not queue checks");
    }
  };

  const onImportSample = async () => {
    try {
      const result = await api<BulkImportResult>("/api/urls/bulk", {
        method: "POST",
        body: SAMPLE_URLS,
      });
      notify("success", `Imported ${result.created.length} URLs`);
      reload();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "Import failed");
    }
  };

  const rows = (list.data?.items ?? []).map((row) => rowOverrides[row.id] ?? row);
  const total = list.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const summaryData = summary.data;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Card label="Total URLs" value={summaryData?.totalUrls ?? "—"} />
        <Card label="Up" value={summaryData?.up ?? "—"} />
        <Card label="Down" value={summaryData?.down ?? "—"} />
        <Card label="Pending" value={summaryData?.pending ?? "—"} />
        <Card
          label="Uptime 24h"
          value={summaryData?.uptimePct24h === null ? "—" : `${summaryData?.uptimePct24h ?? "—"}%`}
          subtitle={
            summaryData ? `${summaryData.failures24h} failures in the last 24h` : undefined
          }
        />
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <form onSubmit={onAdd} className="flex flex-wrap items-end gap-3">
          <label className="flex-1 text-sm font-medium text-gray-700">
            URL
            <input
              type="text"
              required
              placeholder="https://example.com"
              value={newUrl}
              onChange={(event) => setNewUrl(event.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </label>
          <label className="text-sm font-medium text-gray-700">
            Interval
            <select
              value={newInterval}
              onChange={(event) => setNewInterval(Number(event.target.value))}
              className="mt-1 block rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
            >
              {INTERVAL_OPTIONS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds / 60} min
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? <Spinner /> : "Add"}
          </Button>
          <Button onClick={() => setBulkOpen(true)}>Bulk import</Button>
          <Button onClick={onCheckAll}>Check all</Button>
          {user?.role === "ADMIN" ? (
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(event) => {
                  setShowAll(event.target.checked);
                  setPage(1);
                }}
              />
              Show all users&apos; URLs
            </label>
          ) : null}
        </form>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {list.loading && rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-gray-900">No URLs yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
              Add a URL above to start monitoring it, or import a few to see how it works.
            </p>
            <div className="mt-4">
              <Button variant="primary" onClick={onImportSample}>
                Try the sample
              </Button>
            </div>
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">URL</th>
                <th className="px-3 py-2 font-medium">Last check</th>
                <th className="px-3 py-2 font-medium">Response</th>
                <th className="px-3 py-2 font-medium">Code</th>
                <th className="px-3 py-2 font-medium">Error</th>
                <th className="px-3 py-2 font-medium">Interval</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <StatusPill status={displayStatus(row)} />
                  </td>
                  <td className="max-w-xs truncate px-3 py-2">
                    <Link
                      to={`/urls/${row.id}`}
                      className="text-indigo-600 hover:underline"
                      title={row.url}
                    >
                      {row.url}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-500">
                    {row.lastCheck ? relativeTime(row.lastCheck.checkedAt) : "—"}
                  </td>
                  <td className="px-3 py-2 text-gray-700">
                    {row.lastCheck?.responseMs != null ? `${row.lastCheck.responseMs} ms` : "—"}
                  </td>
                  <td className="px-3 py-2 text-gray-700">{row.lastCheck?.statusCode ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-700" title={row.lastCheck?.errorMessage ?? ""}>
                    {row.lastCheck?.errorType ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-500">
                    {formatSeconds(row.intervalSeconds)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onCheckNow(row.id)}
                        disabled={busyRow === row.id}
                        className="text-indigo-600 hover:underline disabled:opacity-50"
                      >
                        {busyRow === row.id ? <Spinner /> : "Check now"}
                      </button>
                      <button
                        type="button"
                        onClick={() => onToggleActive(row)}
                        className="text-gray-600 hover:underline"
                      >
                        {row.isActive ? "Pause" : "Resume"}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(row)}
                        className="text-red-600 hover:underline"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {rows.length > 0 ? (
          <div className="flex items-center justify-between border-t border-gray-200 px-3 py-2 text-sm text-gray-500">
            <span>
              Page {list.data?.page ?? page} of {lastPage} · {total} total
            </span>
            <div className="flex gap-2">
              <Button onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>
                Previous
              </Button>
              <Button
                onClick={() => setPage((value) => Math.min(lastPage, value + 1))}
                disabled={page >= lastPage}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {bulkOpen ? (
        <BulkImportModal
          onClose={() => setBulkOpen(false)}
          onImported={() => {
            setBulkOpen(false);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function BulkImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const { notify } = useToast();
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BulkImportResult | null>(null);

  const submit = async () => {
    // Accept either a pasted JSON array or one URL per line.
    let urls: string[];
    const trimmed = text.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
          throw new Error("not an array");
        }
        urls = parsed.map(String);
      } catch {
        notify("error", "That looks like JSON but could not be parsed as an array of URLs");
        return;
      }
    } else {
      urls = trimmed
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }

    if (urls.length === 0) {
      notify("error", "Enter at least one URL");
      return;
    }

    setSubmitting(true);
    try {
      const data = await api<BulkImportResult>("/api/urls/bulk", { method: "POST", body: urls });
      setResult(data);
      notify("success", `Imported ${data.created.length}, skipped ${data.skipped.length}`);
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "Import failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-lg rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-base font-medium text-gray-900">Bulk import</h2>
        <p className="mt-1 text-xs text-gray-500">
          One URL per line, or paste a JSON array. Up to 100 at a time.
        </p>

        <textarea
          rows={8}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={"https://www.google.com\nhttps://www.github.com"}
          className="mt-3 w-full rounded border border-gray-300 p-2 font-mono text-xs focus:border-indigo-500 focus:outline-none"
        />

        {result ? (
          <div className="mt-3 max-h-40 overflow-y-auto rounded border border-gray-200 bg-gray-50 p-2 text-xs">
            <p className="font-medium text-green-700">Created {result.created.length}</p>
            {result.created.map((url) => (
              <p key={url.id} className="truncate text-gray-600">
                {url.url}
              </p>
            ))}
            {result.skipped.length > 0 ? (
              <>
                <p className="mt-2 font-medium text-amber-700">Skipped {result.skipped.length}</p>
                {result.skipped.map((item, index) => (
                  <p key={`${item.url}-${index}`} className="truncate text-gray-600">
                    {item.url}: {item.reason}
                  </p>
                ))}
              </>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={result ? onImported : onClose}>{result ? "Done" : "Cancel"}</Button>
          <Button variant="primary" onClick={submit} disabled={submitting}>
            {submitting ? <Spinner /> : "Import"}
          </Button>
        </div>
      </div>
    </div>
  );
}
