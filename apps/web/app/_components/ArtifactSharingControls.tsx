"use client";

import type { WorkspaceArtifact } from "@mai-chat/shared-types";

type Props = {
  artifact: WorkspaceArtifact;
  publicUrl: string;
  slackChannel: string;
  saving: boolean;
  onSlackChannelChange: (value: string) => void;
  onCreatePublicLink: () => void;
  onCopyPublicLink: () => void;
  onRevokePublicLink: () => void;
  onShareToSlack: () => void;
};

export function ArtifactSharingControls({ artifact, publicUrl, slackChannel, saving, onSlackChannelChange, onCreatePublicLink, onCopyPublicLink, onRevokePublicLink, onShareToSlack }: Props) {
  if (artifact.status !== "published") return null;
  return <section className="artifact-sharing"><h3>Share published artifact</h3>{artifact.shareToken ? <div><input readOnly value={publicUrl} aria-label="Public artifact link" /><button type="button" className="secondary-button" onClick={onCopyPublicLink}>Copy link</button><button type="button" className="secondary-button" disabled={saving} onClick={onRevokePublicLink}>Revoke link</button></div> : <button type="button" className="secondary-button" disabled={saving} onClick={onCreatePublicLink}>Create public link</button>}<div><input value={slackChannel} onChange={(event) => onSlackChannelChange(event.target.value)} placeholder="Slack channel, e.g. team-updates" aria-label="Slack channel" /><button type="button" className="secondary-button" disabled={saving} onClick={onShareToSlack}>Share to Slack</button></div></section>;
}
