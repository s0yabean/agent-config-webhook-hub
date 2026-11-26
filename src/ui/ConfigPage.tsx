import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { api } from "./api";

interface Props {
  onAuthError: (e: unknown) => boolean;
}

export function ConfigPage({ onAuthError }: Props) {
  const [parentIds, setParentIds] = useState<string[]>(["default"]);
  const [parentId, setParentId] = useState("default");
  const [pairs, setPairs] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<{ key: string; value: string; original?: string } | null>(null);
  const [newNs, setNewNs] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = useCallback((e: unknown) => {
    if (!onAuthError(e)) setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) });
  }, [onAuthError]);

  const loadIds = useCallback(async () => {
    try {
      setParentIds((await api.parentIds()).parentIds);
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  const loadPairs = useCallback(async () => {
    try {
      // The same filtered read an agent makes, so what you see is what it gets.
      const res = search.trim() ? await api.filtered(parentId, search) : await api.values(parentId);
      setPairs(res.pairs);
    } catch (e) {
      fail(e);
    }
  }, [parentId, search, fail]);

  useEffect(() => { void loadIds(); }, [loadIds]);
  useEffect(() => { void loadPairs(); }, [loadPairs]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setStatus(null);
    try {
      setStatus({ ok: true, text: await fn() });
      await Promise.all([loadIds(), loadPairs()]);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = () => {
    if (!editing) return;
    const key = editing.key.trim();
    if (!key) return setStatus({ ok: false, text: "Key cannot be empty" });
    void run(async () => {
      if (editing.original && editing.original !== key) await api.deleteKey(parentId, editing.original);
      const res = await api.save(parentId, { [key]: editing.value });
      setEditing(null);
      return res.message;
    });
  };

  const upload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    void run(async () => {
      const parsed = JSON.parse(await file.text()) as Record<string, string>;
      return (await api.save(parentId, parsed, "merge")).message;
    });
  };

  const download = () => {
    const blob = new Blob([JSON.stringify(pairs, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `config_${parentId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const createNamespace = () => {
    const id = newNs.trim();
    if (!id) return;
    void run(async () => {
      await api.save(id, {});
      setParentId(id);
      setNewNs("");
      return `Created namespace ${id}`;
    });
  };

  const entries = Object.entries(pairs).sort(([a], [b]) => a.localeCompare(b));

  return (
    <section className="card">
      <div className="row wrap">
        <label>
          Namespace (parentId)
          <select value={parentId} onChange={(e) => setParentId(e.target.value)} disabled={busy}>
            {parentIds.map((id) => <option key={id}>{id}</option>)}
          </select>
        </label>
        <label className="grow">
          Filter values (comma-separated terms, any match)
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. refund, wholesale" />
        </label>
        <label>
          New namespace
          <span className="row">
            <input value={newNs} onChange={(e) => setNewNs(e.target.value)} placeholder="e.g. sales-bot" />
            <button onClick={createNamespace} disabled={busy || !newNs.trim()}>Add</button>
          </span>
        </label>
      </div>

      <div className="row wrap actions">
        <button onClick={() => setEditing({ key: "", value: "" })} disabled={busy}>Add value</button>
        <label className="button ghost">
          Upload JSON (merge)
          <input type="file" accept=".json,application/json" onChange={upload} hidden />
        </label>
        <button className="ghost" onClick={download} disabled={!entries.length}>Download</button>
        <button
          className="danger"
          disabled={busy}
          onClick={() => window.confirm(`Delete every value in "${parentId}"?`) &&
            void run(async () => { await api.deleteNamespace(parentId); setParentId("default"); return `Deleted ${parentId}`; })}
        >
          Delete namespace
        </button>
      </div>

      {status && <p className={status.ok ? "ok" : "error"}>{status.text}</p>}

      <table>
        <thead>
          <tr><th>Key</th><th>Value</th><th /></tr>
        </thead>
        <tbody>
          {editing && (
            <tr className="editing">
              <td><input value={editing.key} onChange={(e) => setEditing({ ...editing, key: e.target.value })} placeholder="key" autoFocus /></td>
              <td><input value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} placeholder="value (string)" /></td>
              <td className="right">
                <button onClick={saveEdit} disabled={busy}>Save</button>{" "}
                <button className="ghost" onClick={() => setEditing(null)}>Cancel</button>
              </td>
            </tr>
          )}
          {entries.map(([key, value]) => (
            <tr key={key}>
              <td className="mono">{key}</td>
              <td className="mono wrap-text">{value}</td>
              <td className="right nowrap">
                <button className="ghost" onClick={() => setEditing({ key, value, original: key })}>Edit</button>{" "}
                <button className="ghost danger-text" disabled={busy}
                  onClick={() => void run(async () => { await api.deleteKey(parentId, key); return `Deleted ${key}`; })}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {!entries.length && !editing && (
            <tr><td colSpan={3} className="muted center">{search ? "No values match." : "No values in this namespace yet."}</td></tr>
          )}
        </tbody>
      </table>

      <p className="muted small">
        Agents read these with <code>GET /api/getValue?parentId={parentId}&amp;key=…</code> or{" "}
        <code>/api/getFilteredValues?parentId={parentId}&amp;searchTerms=…</code>. See docs/api.md.
      </p>
    </section>
  );
}
