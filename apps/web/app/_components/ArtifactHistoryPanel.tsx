"use client";

import type { WorkspaceArtifactComment, WorkspaceArtifactVersion } from "@mai-chat/shared-types";

export function ArtifactHistoryPanel({ versions, comments, comment, onCommentChange, onAddComment, onRestore }: { versions: WorkspaceArtifactVersion[]; comments: WorkspaceArtifactComment[]; comment: string; onCommentChange: (value: string) => void; onAddComment: () => void; onRestore: (version: WorkspaceArtifactVersion) => void }) {
  return <><section className="artifact-history"><h3>Version history</h3>{versions.slice(0, 5).map((version) => <div key={version.id}><span>Version {version.version} · {version.savedByName ?? "Former member"}</span><button className="secondary-button" onClick={() => onRestore(version)}>Restore</button></div>)}</section><section className="artifact-comments"><h3>Comments</h3>{comments.map((entry) => <article key={entry.id}><strong>{entry.authorName ?? "Former member"}</strong><small>{new Date(entry.createdAt).toLocaleString()}</small><p>{entry.content}</p></article>)}<div><textarea rows={2} value={comment} onChange={(event) => onCommentChange(event.target.value)} placeholder="Leave feedback for the team" /><button className="secondary-button" disabled={!comment.trim()} onClick={onAddComment}>Add comment</button></div></section></>;
}
