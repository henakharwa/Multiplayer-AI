"use client";

// The "+ Add channel" popup: pick which collaboration tool to connect.
// Both GitHub and Slack go through a real OAuth login now
// (services/chat-server's github-oauth.ts / slack-oauth.ts) -- Slack used
// to fall back to a pasted-bot-token form on the Integrations settings
// page, but that stopped being an option once Slack tools moved to
// Slack's own official MCP server, which only accepts a token minted by
// this exact OAuth flow (see slack-oauth.ts's own comment).
import { githubOAuthStartUrl, providerOAuthStartUrl, slackOAuthStartUrl } from "../../lib/api";

export default function ConnectChannelModal({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  function connectGithub() {
    // A full top-level navigation, not a fetch -- the browser needs to
    // follow the redirect to github.com's consent screen and back.
    window.location.href = githubOAuthStartUrl(workspaceId);
  }

  function connectSlack() {
    // Same reasoning as connectGithub above, pointed at slack.com's
    // consent screen instead.
    window.location.href = slackOAuthStartUrl(workspaceId);
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="card channel-menu" onClick={(e) => e.stopPropagation()}>
        <p className="brand">Add a channel</p>
        <h1 className="title" style={{ marginBottom: 16 }}>
          Connect a collaboration tool
        </h1>

        <button className="channel-option" data-testid="connect-github-option" onClick={connectGithub}>
          <span className="channel-icon" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </span>
          <span className="channel-option-text">
            <span className="channel-option-title">GitHub</span>
            <span className="channel-option-hint">Log in with GitHub, then pick a repository</span>
          </span>
          <span className="channel-option-arrow" aria-hidden>
            →
          </span>
        </button>

        <button className="channel-option" data-testid="connect-slack-option" onClick={connectSlack}>
          <span className="channel-icon" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 15a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 1 1 4 0v5a2 2 0 1 1-4 0v-5Z" fill="#e01e5a" />
              <path d="M9 6a2 2 0 1 1 2-2v2H9Zm0 1a2 2 0 1 1 0 4H4a2 2 0 1 1 0-4h5Z" fill="#36c5f0" />
              <path d="M18 9a2 2 0 1 1 2 2h-2V9Zm-1 0a2 2 0 1 1-4 0V4a2 2 0 1 1 4 0v5Z" fill="#2eb67d" />
              <path d="M15 18a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 1 1 0-4h5a2 2 0 1 1 0 4h-5Z" fill="#ecb22e" />
            </svg>
          </span>
          <span className="channel-option-text">
            <span className="channel-option-title">Slack</span>
            <span className="channel-option-hint">Log in with Slack, then pick a workspace</span>
          </span>
          <span className="channel-option-arrow" aria-hidden>
            →
          </span>
        </button>

        {(["linear", "notion", "figma"] as const).map((item) => <button className="channel-option" key={item} onClick={() => { window.location.href = providerOAuthStartUrl(workspaceId, item); }}><span className="channel-icon">{item[0].toUpperCase()}</span><span className="channel-option-text"><span className="channel-option-title">{item[0].toUpperCase() + item.slice(1)}</span><span className="channel-option-hint">Sign in with your {item[0].toUpperCase() + item.slice(1)} account</span></span><span className="channel-option-arrow">→</span></button>)}

        <button className="btn secondary" style={{ marginTop: 18 }} onClick={onClose} data-testid="connect-channel-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}
