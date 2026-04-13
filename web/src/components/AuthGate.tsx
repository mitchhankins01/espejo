import { useState, useEffect, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { getToken, setToken, clearToken } from "../api.ts";

export function AuthGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [authed, setAuthed] = useState(!!getToken());
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(!!getToken());

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    setChecking(true);
    fetch("/api/artifacts?limit=1", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (res.ok) {
          setAuthed(true);
        } else {
          clearToken();
          setAuthed(false);
        }
      })
      .catch(() => {
        clearToken();
        setAuthed(false);
      })
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-surface-alt">
        <p className="text-text-muted">Authenticating...</p>
      </div>
    );
  }

  if (authed) {
    const onWeight = location.pathname.startsWith("/weight");
    const onDb = location.pathname.startsWith("/db");
    const onJournal =
      location.pathname.startsWith("/journal") ||
      location.pathname.startsWith("/templates");
    const onKnowledge = !onWeight && !onDb && !onJournal;
    return (
      <div className="min-h-screen bg-surface-alt">
        <nav className="border-b border-border bg-surface">
          <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-2">
            <Link
              to="/"
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                onKnowledge
                  ? "bg-pine-600 dark:bg-pine-500 text-white"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              Knowledge Base
            </Link>
            <Link
              to="/weight"
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                onWeight
                  ? "bg-pine-600 dark:bg-pine-500 text-white"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              Weight
            </Link>
            <Link
              to="/journal"
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                onJournal
                  ? "bg-pine-600 dark:bg-pine-500 text-white"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              Journal
            </Link>
            <Link
              to="/db"
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                onDb
                  ? "bg-pine-600 dark:bg-pine-500 text-white"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              DB
            </Link>
          </div>
        </nav>
        {children}
      </div>
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;

    setError("");
    setChecking(true);
    fetch("/api/artifacts?limit=1", {
      headers: { Authorization: `Bearer ${input.trim()}` },
    })
      .then((res) => {
        if (res.ok) {
          setToken(input.trim());
          setAuthed(true);
        } else {
          setError("Invalid token");
        }
      })
      .catch(() => setError("Connection failed"))
      .finally(() => setChecking(false));
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-surface-alt px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-center mb-8 text-text-primary">Espejo</h1>
        <label htmlFor="auth-token" className="block text-sm text-text-muted mb-1.5 font-medium">
          Access Token
        </label>
        <input
          id="auth-token"
          type="password"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Enter access token"
          autoFocus
          aria-label="Access token"
          className="w-full px-3 py-2.5 rounded-lg border border-border bg-surface text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500 mb-3 text-base"
        />
        {error && (
          <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 mb-3">
            {error}
          </div>
        )}
        <button
          className="w-full py-2.5 rounded-lg bg-pine-600 dark:bg-pine-500 text-white font-medium hover:bg-pine-700 dark:hover:bg-pine-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={checking}
        >
          {checking ? "Checking..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
