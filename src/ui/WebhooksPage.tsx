import { useCallback, useEffect, useState } from "react";
import { api, type DeliveryLog, type WebhookInput, type WebhookView } from "./api";

interface Props {
  onAuthError: (e: unknown) => boolean;
}

interface Draft extends WebhookInput {
  headerText: string;
  isNew: boolean;
  hasSecret: boolean;
}

const EMPTY: Draft = {
  parentId: "",
  webhookUrl: "",
  sender_id: "",
  description: "",
  isActive: true,
  headerText: "",
  secret: undefined,
  isNew: true,
  hasSecret: false
};

function headersToText(h?: Record<string, string>) {
  return Object.entries(h || {}).map(([k, v]) => `${k}: ${v}`).join("\n");
}

function textToHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function WebhooksPage({ onAuthError }: Props) {
  const [webhooks, setWebhooks] = useState<WebhookView[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [logs, setLogs] = useState<DeliveryLog[]>([]);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const fail = useCallback((e: unknown) => {
    if (!onAuthError(e)) setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) });
  }, [onAuthError]);

  const load = useCallback(async () => {
    try {
      setWebhooks((await api.webhooks()).webhooks);
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  useEffect(() => { void load(); }, [load]);

  const showLogs = async (parentId: string) => {
    if (logsFor === parentId) return setLogsFor(null);
    try {
      setLogs((await api.deliveryLogs(parentId)).logs);
      setLogsFor(parentId);
    } catch (e) {
      fail(e);
    }
  };

  const save = async () => {
    if (!draft) return;
    setStatus(null);
    try {
      const res = await api.saveWebhook({
        parentId: draft.parentId.trim(),
        webhookUrl: draft.webhookUrl.trim(),
        sender_id: draft.sender_id.trim(),
        description: draft.description,
        isActive: draft.isActive,
        headers: textToHeaders(draft.headerText),
        secret: draft.secret
      });
      setStatus({ ok: true, text: res.message });
      setDraft(null);
      await load();
    } catch (e) {
      fail(e);
    }
  };

  const test = async (parentId: string) => {
    setStatus(null);
    try {
      const res = await api.testWebhook(parentId);
      setStatus({ ok: res.success, text: res.success ? res.message || "Test delivered" : res.error || "Test failed" });
      await load();
      if (logsFor === parentId) setLogs((await api.deliveryLogs(parentId)).logs);
    } catch (e) {
      fail(e);
    }
  };

  const remove = async (parentId: string) => {
    if (!window.confirm(`Delete the route for "${parentId}"?`)) return;
    try {
      await api.deleteWebhook(parentId);
      setStatus({ ok: true, text: `Deleted ${parentId}` });
      await load();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <section className="card">
      <p className="muted">
        WAHA posts every event to <code>{window.location.origin}/api/webhookReceiver</code>. The hub looks up the
        sender's chat ID below and forwards the event to that agent workflow's webhook. Unknown or inactive senders
        are rejected and logged.
      </p>

      <div className="row actions">
        <button onClick={() => setDraft({ ...EMPTY })}>Add route</button>
      </div>
      {status && <p className={status.ok ? "ok" : "error"}>{status.text}</p>}

      {draft && (
        <div className="form">
          <label>parentId <input value={draft.parentId} disabled={!draft.isNew} onChange={(e) => setDraft({ ...draft, parentId: e.target.value })} placeholder="e.g. support-bot" /></label>
          <label>Sender chat ID <input value={draft.sender_id} onChange={(e) => setDraft({ ...draft, sender_id: e.target.value })} placeholder="15550100001@c.us" /></label>
          <label className="span2">Agent webhook URL <input value={draft.webhookUrl} onChange={(e) => setDraft({ ...draft, webhookUrl: e.target.value })} placeholder="https://example.com/agent-webhook" /></label>
          <label className="span2">Description <input value={draft.description || ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
          <label>Extra headers (one "Name: value" per line)
            <textarea rows={3} value={draft.headerText} onChange={(e) => setDraft({ ...draft, headerText: e.target.value })} />
          </label>
          <label>Signing secret {draft.hasSecret && <span className="muted">(set; leave blank to keep)</span>}
            <input type="password" value={draft.secret ?? ""} onChange={(e) => setDraft({ ...draft, secret: e.target.value || undefined })} />
          </label>
          <label className="check"><input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} /> Active</label>
          <div className="row span2">
            <button onClick={save}>Save route</button>
            <button className="ghost" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}

      <table>
        <thead>
          <tr><th>parentId</th><th>Sender</th><th>Target</th><th>State</th><th>Last used</th><th /></tr>
        </thead>
        <tbody>
          {webhooks.map((w) => (
            <RouteRows key={w.parentId} w={w} open={logsFor === w.parentId} logs={logs}
              onEdit={() => setDraft({ ...EMPTY, ...w, secret: undefined, headerText: headersToText(w.headers), isNew: false })}
              onTest={() => void test(w.parentId)}
              onLogs={() => void showLogs(w.parentId)}
              onDelete={() => void remove(w.parentId)} />
          ))}
          {!webhooks.length && <tr><td colSpan={6} className="muted center">No routes yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

function RouteRows(props: {
  w: WebhookView;
  open: boolean;
  logs: DeliveryLog[];
  onEdit: () => void;
  onTest: () => void;
  onLogs: () => void;
  onDelete: () => void;
}) {
  const { w } = props;
  return (
    <>
      <tr>
        <td className="mono">{w.parentId}{w.hasSecret && <span className="pill">signed</span>}</td>
        <td className="mono">{w.sender_id}</td>
        <td className="mono wrap-text">{w.webhookUrl}<div className="muted small">{w.description}</div></td>
        <td><span className={`pill ${w.isActive ? "pill-ok" : ""}`}>{w.isActive ? "active" : "paused"}</span></td>
        <td className="small">{w.lastUsed ? new Date(w.lastUsed).toLocaleString() : "never"}</td>
        <td className="right nowrap">
          <button className="ghost" onClick={props.onTest} disabled={!w.isActive}>Test</button>{" "}
          <button className="ghost" onClick={props.onLogs}>{props.open ? "Hide log" : "Deliveries"}</button>{" "}
          <button className="ghost" onClick={props.onEdit}>Edit</button>{" "}
          <button className="ghost danger-text" onClick={props.onDelete}>Delete</button>
        </td>
      </tr>
      {props.open && (
        <tr className="sub">
          <td colSpan={6}>
            {props.logs.length === 0 ? <span className="muted">No deliveries yet.</span> : (
              <table className="inner">
                <thead><tr><th>When</th><th>Result</th><th>HTTP</th><th>Attempts</th><th>ms</th><th>Error</th></tr></thead>
                <tbody>
                  {props.logs.map((l, i) => (
                    <tr key={i}>
                      <td className="small">{new Date(l.timestamp).toLocaleString()}</td>
                      <td><span className={`pill ${l.success ? "pill-ok" : "pill-bad"}`}>{l.success ? "ok" : "failed"}</span></td>
                      <td>{l.statusCode ?? "-"}</td>
                      <td>{l.attempts}</td>
                      <td>{l.responseTime}</td>
                      <td className="small wrap-text">{l.error || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
