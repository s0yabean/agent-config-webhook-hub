import { Fragment, useCallback, useEffect, useState } from "react";
import { api, type IncomingLog } from "./api";

interface Props {
  onAuthError: (e: unknown) => boolean;
}

const STATUS_CLASS: Record<IncomingLog["status"], string> = {
  forwarded: "pill-ok",
  rejected: "pill-warn",
  failed: "pill-bad"
};

export function LogsPage({ onAuthError }: Props) {
  const [logs, setLogs] = useState<IncomingLog[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [filter, setFilter] = useState<"all" | IncomingLog["status"]>("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLogs((await api.incomingLogs()).logs);
    } catch (e) {
      if (!onAuthError(e)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => { void load(); }, [load]);

  const shown = filter === "all" ? logs : logs.filter((l) => l.status === filter);

  return (
    <section className="card">
      <div className="row wrap actions">
        <p className="muted grow">The last 100 requests that reached the receiver, newest first, with the raw payload as it arrived.</p>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">All</option>
          <option value="forwarded">Forwarded</option>
          <option value="rejected">Rejected</option>
          <option value="failed">Failed</option>
        </select>
        <button className="ghost" onClick={() => void load()} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
      </div>
      {error && <p className="error">{error}</p>}

      <table>
        <thead>
          <tr><th>When</th><th>Status</th><th>Sender</th><th>Event</th><th>Routed to</th><th>Reason</th></tr>
        </thead>
        <tbody>
          {shown.map((l, i) => (
            <Fragment key={`${l.timestamp}-${i}`}>
              <tr className="clickable" onClick={() => setOpen(open === i ? null : i)}>
                <td className="small nowrap">{new Date(l.timestamp).toLocaleString()}</td>
                <td><span className={`pill ${STATUS_CLASS[l.status]}`}>{l.status}</span></td>
                <td className="mono">{l.sender_id}</td>
                <td className="mono">{l.event_type}</td>
                <td className="mono">{l.determined_parent_id || "-"}</td>
                <td className="small wrap-text">{l.reason || ""}</td>
              </tr>
              {open === i && (
                <tr className="sub">
                  <td colSpan={6}><pre>{JSON.stringify(l.raw_payload, null, 2)}</pre></td>
                </tr>
              )}
            </Fragment>
          ))}
          {!shown.length && <tr><td colSpan={6} className="muted center">No incoming webhooks logged yet. Try <code>npm run send-sample</code>.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
