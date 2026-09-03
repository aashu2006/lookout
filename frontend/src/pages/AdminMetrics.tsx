import { api } from "../api/client";
import type { Metrics } from "../api/types";
import { Card } from "../components/ui";
import { usePolling } from "../hooks/usePolling";

export function AdminMetrics() {
  const metrics = usePolling<Metrics>(() => api<Metrics>("/api/metrics"), 5000);
  const data = metrics.data;

  if (metrics.loading && !data) {
    return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  }
  if (!data) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
        Metrics unavailable.
      </div>
    );
  }

  const { lastHour, perMinute } = data.checks;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-medium text-gray-900">Metrics</h1>
        <p className="text-xs text-gray-500">
          Updated {new Date(data.timestamp).toLocaleTimeString()} · refreshes every 5s
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-700">Checks, last hour</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Card label="Total" value={lastHour.total} subtitle={`${perMinute}/min`} />
          <Card label="Failures" value={lastHour.failures} />
          <Card
            label="Failure rate"
            value={
              lastHour.failureRate == null ? "—" : `${Math.round(lastHour.failureRate * 100)}%`
            }
          />
          <Card label="Avg" value={lastHour.avgMs == null ? "—" : `${lastHour.avgMs} ms`} />
          <Card label="P95" value={lastHour.p95Ms == null ? "—" : `${lastHour.p95Ms} ms`} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-700">Check queue</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Card label="Waiting" value={data.queue.waiting} />
          <Card label="Active" value={data.queue.active} />
          <Card label="Completed" value={data.queue.completed} />
          <Card label="Failed" value={data.queue.failed} />
          <Card label="Delayed" value={data.queue.delayed} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-700">API process</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Card label="Uptime" value={`${Math.floor(data.process.uptimeSec / 60)}m`} />
          <Card label="RSS" value={`${data.process.rssMb} MB`} />
          <Card label="Heap used" value={`${data.process.heapUsedMb} MB`} />
        </div>
      </section>
    </div>
  );
}
