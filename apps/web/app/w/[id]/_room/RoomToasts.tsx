export type RoomNotice = { kind: "success" | "error"; text: string };

// Connection and integration notices stacked at the top of the room.
export default function RoomToasts({
  reconnecting,
  closeReason,
  onReconnect,
  githubNotice,
  slackNotice,
  onDismissGithub,
  onDismissSlack,
}: {
  reconnecting: boolean;
  // Set when the live connection closed and the room should offer to reconnect.
  closeReason: string | null;
  onReconnect: () => void;
  githubNotice: RoomNotice | null;
  slackNotice: RoomNotice | null;
  onDismissGithub: () => void;
  onDismissSlack: () => void;
}) {
  if (!reconnecting && !closeReason && !githubNotice && !slackNotice) return null;
  return (
    <div className="workspace-toast-stack" aria-live="polite">
      {reconnecting && (
        <div className="workspace-toast reconnecting" data-testid="reconnecting-notice">
          <span>Reconnecting to the workspace…</span>
          <button disabled>Reconnecting</button>
        </div>
      )}
      {closeReason && (
        <div className="workspace-toast error" data-testid="disconnect-banner">
          <span>{closeReason}</span>
          <button onClick={onReconnect} disabled={reconnecting}>
            {reconnecting ? "Reconnecting" : "Reconnect"}
          </button>
        </div>
      )}
      {githubNotice && (
        <div
          className={`workspace-toast ${githubNotice.kind === "success" ? "success" : "error"}`}
          data-testid="github-notice"
        >
          <span>{githubNotice.text}</span>
          <button onClick={onDismissGithub}>Dismiss</button>
        </div>
      )}
      {slackNotice && (
        <div
          className={`workspace-toast ${slackNotice.kind === "success" ? "success" : "error"}`}
          data-testid="slack-notice"
        >
          <span>{slackNotice.text}</span>
          <button onClick={onDismissSlack}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
