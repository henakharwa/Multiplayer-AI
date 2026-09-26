"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { acceptWorkspaceInvitation, createWorkspace, getWorkspaceByJoinCode, ApiError } from "../lib/api";
import BrandMark from "./_components/Logo";
import { useCurrentUser } from "../lib/useCurrentUser";
import { logout } from "../lib/api";
import AuthDialog from "./_components/AuthDialog";
import EmailVerificationBanner from "./_components/EmailVerificationBanner";

export default function HomePage() {
  const router = useRouter();
  const auth = useCurrentUser();
  const [authMode, setAuthMode] = useState<"signin" | "signup" | null>(null);
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState("");
  const inviteHandled = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setName(params.get("workspaceName") ?? "");
    setJoinCode(params.get("joinCode") ?? "");
    setInviteToken(params.get("invite") ?? "");
    if (params.get("loginError")) {
      setError(params.get("loginError"));
      setAuthMode("signin");
    }
  }, []);

  useEffect(() => {
    if (!auth.user || !inviteToken || inviteHandled.current) return;
    inviteHandled.current = true;
    acceptWorkspaceInvitation(inviteToken)
      .then(({ workspaceId }) => router.replace(`/w/${workspaceId}`))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not accept this invitation."));
  }, [auth.user, inviteToken, router]);

  const returnParams = new URLSearchParams();
  if (name) returnParams.set("workspaceName", name);
  if (joinCode) returnParams.set("joinCode", joinCode);
  if (inviteToken) returnParams.set("invite", inviteToken);
  const returnTo = returnParams.size ? `/?${returnParams}` : "/";

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (!auth.user) { setAuthMode("signin"); return; }
    setCreating(true);
    setError(null);
    try {
      const workspace = await createWorkspace(name.trim());
      router.push(`/w/${workspace.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { auth.refresh(); setAuthMode("signin"); }
      setError(err instanceof ApiError ? err.message : "Could not create the workspace. Is the chat server running?");
      setCreating(false);
    }
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!joinCode.trim()) return;
    if (!auth.user) { setAuthMode("signin"); return; }
    setJoining(true);
    setError(null);
    try {
      const workspace = await getWorkspaceByJoinCode(joinCode.trim());
      router.push(`/w/${workspace.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { auth.refresh(); setAuthMode("signin"); }
      setError(err instanceof ApiError && err.status === 404 ? "No workspace found for that join code." : "Could not reach the chat server.");
      setJoining(false);
    }
  }

  return (
    <div className="home-shell">
      <nav className="home-nav">
        <BrandMark />
        <div className="auth-nav">
          {auth.user ? <>
            <span className="account-name">{auth.user.displayName}</span>
            <button className="auth-nav-button" onClick={async () => { await logout(); auth.refresh(); }}>Sign Out</button>
          </> : <>
            <button className="auth-nav-button" onClick={() => { setError(null); setAuthMode("signup"); }} data-testid="sign-up-btn">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="9" cy="7" r="4"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M19 8v6m-3-3h6"/></svg>
              Sign Up
            </button>
            <button className="auth-nav-button primary" onClick={() => { setError(null); setAuthMode("signin"); }} data-testid="sign-in-btn">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M14 4h6v16h-6M3 12h12m-4-4 4 4-4 4"/></svg>
              Sign In
            </button>
          </>}
        </div>
      </nav>
      {authMode && <AuthDialog mode={authMode} returnTo={returnTo} error={error} onClose={() => setAuthMode(null)} />}
      {auth.user && <EmailVerificationBanner user={auth.user} />}

      <div className="home-hero">
        <span className="eyebrow">Shared AI workspace</span>
        <h1>Your team and an AI teammate, in one shared chat</h1>
        <p className="lede">
          Bring GitHub, Slack, Linear, Notion, and Figma into one shared conversation. Your team sees the same context, agents, and approved actions.
        </p>

        {!auth.user && <div className="home-primary-actions">
          <button className="btn home-primary-cta" onClick={() => { setError(null); setAuthMode("signup"); }}>Create your workspace</button>
          <button className="home-text-action" onClick={() => { setError(null); setAuthMode("signin"); }}>Already have an account? Sign in</button>
        </div>}

        <div className="home-panels">
          {auth.user && <div className="home-panel">
            <span className="panel-icon blue" aria-hidden>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </span>
            <h2>Start a new workspace</h2>
            <p className="panel-hint">Spin up a fresh shared space for your team and get a join code to invite others.</p>
            <form onSubmit={handleCreate}>
              <div className="field">
                <label htmlFor="workspace-name">Workspace name</label>
                <input
                  id="workspace-name"
                  data-testid="workspace-name-input"
                  placeholder="Acme Engineering"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <button className="btn" type="submit" data-testid="create-workspace-btn" disabled={auth.status === "loading" || creating || !name.trim()}>
                {creating ? "Creating…" : "Create workspace"}
              </button>
            </form>
          </div>}

          {auth.user && <div className="home-panel">
            <span className="panel-icon violet" aria-hidden>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M4 12a8 8 0 1 1 3.2 6.4L4 19l0.9-3A8 8 0 0 1 4 12Z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <h2>Join an existing one</h2>
            <p className="panel-hint">Already have a join code from a teammate? Drop in and pick up the conversation.</p>
            <form onSubmit={handleJoin}>
              <div className="field">
                <label htmlFor="join-code">Join code</label>
                <input
                  id="join-code"
                  data-testid="join-code-input"
                  placeholder="e.g. bright-otter-42"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <button className="btn secondary" type="submit" data-testid="join-workspace-btn" disabled={auth.status === "loading" || joining || !joinCode.trim()}>
                {joining ? "Joining…" : "Join workspace"}
              </button>
            </form>
          </div>}
        </div>

        {error && (
          <div className="home-error">
            <p className="error-text" data-testid="home-error">
              {error}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
