import { useCallback, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ApiError, api, errorMessage } from "../api/client";
import type { Check, ManualCheckResponse, StatsWindow, Url, UrlStats } from "../api/types";
import { useToast } from "../components/Toast";
import { Button, Card, Spinner, StatusPill, displayStatus } from "../components/ui";
import { usePolling } from "../hooks/usePolling";
import { formatClock, formatDateTime, formatSeconds, relativeTime } from "../utils/time";

const WINDOWS: StatsWindow[] = ["24h", "7d", "30d"];

export function UrlDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { notify } = useToast();

  const [window_, setWindow] = useState<StatsWindow>("24h");
  const [checking, setChecking] = useState(false);

  const detail = usePolling<{ url: Url }>(() => api<{ url: Url }>(`/api/urls/${id}`), 10000, [id]);
  const stats = usePolling<UrlStats>(
    () => api<UrlStats>(`/api/urls/${id}/stats?window=${window_}`),
    10000,
    [id, window_],
  );
  const checks = usePolling<{ items: Check[] }>(
    () => api<{ items: Check[] }>(`/api/urls/${id}/checks?limit=50`),
    10000,
    [id],
  );

  const refreshAll = useCallback(() => {
    detail.refresh();
    stats.refresh();
    checks.refresh();
  }, [detail, stats, checks]);

  const url = detail.data?.url;
  const latest = checks.data?.items[0] ?? null;

  const onCheckNow = async () => {
    setChecking(true);
    try {
      const result = await api<ManualCheckResponse>(`/api/urls/${id}/check`, { method: "POST" });
      notify("success", "check" in result ? `Checked: ${result.check.status}` : "Check queued");
      refreshAll();
    } catch (err) {
      notify("error", errorMessage(err, "Check failed"));
    } finally {
      setChecking(false);
    }
  };

  const onToggleActive = async () => {
    if (!url) {
      return;
    }
    try {
      await api(`/api/urls/${id}`, { method: "PATCH", body: { isActive: !url.isActive } });
      notify("success", url.isActive ? "Paused" : "Resumed");
      refreshAll();
    } catch (err) {
      notify("error", errorMessage(err, "Update failed"));
    }
  };

  const onDelete = async () => {
    if (!url || !window.confirm(`Delete ${url.url}?`)) {
      return;
    }
    try {
      await api(`/api/urls/${id}`, { method: "DELETE" });
      notify("success", "Deleted");
      navigate("/", { replace: true });
    } catch (err) {
      notify("error", errorMessage(err, "Delete failed"));
    }
  };

  // One failed poll shouldn't hide data we already have, unless the URL is gone.
  const notFound = detail.error instanceof ApiError && detail.error.status === 404;
  if (detail.error && (!detail.data || notFound)) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
        <p className="text-sm text-gray-700">This URL could not be loaded.</p>
        <Link to="/" className="mt-2 inline-block text-sm text-indigo-600 hover:underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  if (!url) {
    return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  }

  const formatTick = (value: string) =>
    window_ === "24h" ? formatClock(value) : formatDateTime(value);
  const series = stats.data?.series ?? [];
  // A line between two points needs two points: with only a handful of buckets
  // (a URL added minutes ago) the chart would otherwise look empty, so show
  // markers when the series is short and hide them once it gets dense.
  const showDots = series.length <= 8;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <Link to="/" className="text-xs text-gray-500 hover:underline">
          ← Dashboard
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <StatusPill status={displayStatus({ isActive: url.isActive, lastCheck: latest })} />
          <a
            href={url.url}
            target="_blank"
            rel="noreferrer"
            className="text-lg font-medium text-gray-900 hover:underline"
          >
            {url.url}
          </a>
          <span className="text-sm text-gray-500">every {formatSeconds(url.intervalSeconds)}</span>

          <div className="ml-auto flex gap-2">
            <Button variant="primary" onClick={onCheckNow} disabled={checking}>
              {checking ? <Spinner /> : "Check now"}
            </Button>
            <Button onClick={onToggleActive}>{url.isActive ? "Pause" : "Resume"}</Button>
            <Button variant="danger" onClick={onDelete}>
              Delete
            </Button>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {WINDOWS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setWindow(option)}
            className={`rounded border px-3 py-1 text-sm font-medium ${
              option === window_
                ? "border-indigo-600 bg-indigo-600 text-white"
                : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Card
          label="Uptime"
          value={stats.data?.uptimePct == null ? "—" : `${stats.data.uptimePct}%`}
        />
        <Card label="Total checks" value={stats.data?.totalChecks ?? "—"} />
        <Card label="Failures" value={stats.data?.failures ?? "—"} />
        <Card
          label="Avg"
          value={stats.data?.avgMs == null ? "—" : `${Math.round(stats.data.avgMs)} ms`}
        />
        <Card label="P95" value={stats.data?.p95Ms == null ? "—" : `${stats.data.p95Ms} ms`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-medium text-gray-900">Response time</h2>
          <div className="mt-3 h-64">
            {series.length === 0 ? (
              <EmptyChart />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series} margin={{ top: 5, right: 8, bottom: 5, left: -16 }}>
                  <CartesianGrid stroke="#f3f4f6" />
                  <XAxis
                    dataKey="t"
                    tickFormatter={formatTick}
                    tick={{ fontSize: 11, fill: "#6b7280" }}
                  />
                  <YAxis tick={{ fontSize: 11, fill: "#6b7280" }} />
                  <Tooltip
                    labelFormatter={(value) => formatDateTime(String(value))}
                    formatter={(value, name) => [
                      typeof value === "number" ? `${Math.round(value)} ms` : "—",
                      name,
                    ]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="avgMs"
                    name="avg"
                    stroke="#4f46e5"
                    dot={showDots}
                    strokeWidth={2}
                  />
                  <Line
                    type="monotone"
                    dataKey="p95Ms"
                    name="p95"
                    stroke="#f59e0b"
                    dot={showDots}
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-medium text-gray-900">Failures</h2>
          <div className="mt-3 h-64">
            {series.length === 0 ? (
              <EmptyChart />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={series} margin={{ top: 5, right: 8, bottom: 5, left: -16 }}>
                  <CartesianGrid stroke="#f3f4f6" />
                  <XAxis
                    dataKey="t"
                    tickFormatter={formatTick}
                    tick={{ fontSize: 11, fill: "#6b7280" }}
                  />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#6b7280" }} />
                  <Tooltip labelFormatter={(value) => formatDateTime(String(value))} />
                  <Bar dataKey="failures" name="failures" fill="#dc2626" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <h2 className="border-b border-gray-200 px-4 py-3 text-sm font-medium text-gray-900">
          Recent checks
        </h2>
        {checks.data && checks.data.items.length > 0 ? (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Code</th>
                <th className="px-3 py-2 font-medium">Response</th>
                <th className="px-3 py-2 font-medium">Error type</th>
                <th className="px-3 py-2 font-medium">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {checks.data.items.map((check) => (
                <tr key={check.id} className="hover:bg-gray-50">
                  <td
                    className="whitespace-nowrap px-3 py-2 text-gray-500"
                    title={new Date(check.checkedAt).toLocaleString()}
                  >
                    {relativeTime(check.checkedAt)}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={check.status} />
                  </td>
                  <td className="px-3 py-2 text-gray-700">{check.statusCode ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-700">
                    {check.responseMs == null ? "—" : `${check.responseMs} ms`}
                  </td>
                  <td className="px-3 py-2 text-gray-700">{check.errorType ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-500" title={check.errorMessage ?? ""}>
                    <span className="block max-w-xs truncate">{check.errorMessage ?? "—"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="p-8 text-center text-sm text-gray-500">No checks recorded yet.</p>
        )}
      </div>
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-gray-500">
      No data for this window yet.
    </div>
  );
}
