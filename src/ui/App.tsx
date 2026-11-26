import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, setToken } from "./api";
import { ConfigPage } from "./ConfigPage";
import { LogsPage } from "./LogsPage";
import { WebhooksPage } from "./WebhooksPage";

type Tab = "config" | "webhooks" | "logs";
const TABS: { id: Tab; label: string }[] = [
  { id: "config", label: "Config values" },
  { id: "webhooks", label: "Webhook routes" },
  { id: "logs", label: "Incoming webhooks" }
];

function tabFromHash(): Tab {
  const h = window.location.hash.replace("#", "");
  return h === "webhooks" || h === "logs" ? h : "config";
}

export function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    api.authStatus()
      .then((s) => setAuthRequired(s.authRequired))
      .catch(() => setAuthRequired(true));
  }, []);

  /** Any 401 from a page sends the user back to the login form. */
  const onAuthError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      setToken(null);
      setLoggedIn(false);
      return true;
    }
    return false;
  };

  if (authRequired === null) return <main className="shell"><p className="muted">Loading…</p></main>;

  // Try the stored token first; a 401 on the first page load drops back here.
  const needsLogin = authRequired && !loggedIn && !hasStoredToken();

  return (
    <main className="shell">
      <header className="top">
        <div>
          <h1>Agent config &amp; webhook hub</h1>
          <p className="muted">Settings agent workflows read at run time, and a log of every webhook that arrived.</p>
        </div>
        {authRequired && !needsLogin && (
          <button className="ghost" onClick={() => { setToken(null); setLoggedIn(false); window.location.reload(); }}>
            Log out
          </button>
        )}
      </header>

      {needsLogin ? (
        <Login onDone={() => setLoggedIn(true)} />
      ) : (
        <>
          <nav className="tabs">
            {TABS.map((t) => (
              <a key={t.id} href={`#${t.id}`} className={t.id === tab ? "active" : ""}>{t.label}</a>
            ))}
          </nav>
          {tab === "config" && <ConfigPage onAuthError={onAuthError} />}
          {tab === "webhooks" && <WebhooksPage onAuthError={onAuthError} />}
          {tab === "logs" && <LogsPage onAuthError={onAuthError} />}
        </>
      )}
    </main>
  );
}

function hasStoredToken(): boolean {
  try {
    return Boolean(sessionStorage.getItem("hub-admin-token"));
  } catch {
    return false;
  }
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.login(password);
      setToken(token);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card narrow" onSubmit={submit}>
      <h2>Admin login</h2>
      <p className="muted">The password is checked by the server (ADMIN_PASSWORD) and never shipped to the browser.</p>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Admin password" autoFocus />
      {error && <p className="error">{error}</p>}
      <button disabled={busy || !password}>{busy ? "Checking…" : "Log in"}</button>
    </form>
  );
}
