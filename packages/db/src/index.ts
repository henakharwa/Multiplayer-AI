// Public API of @mai-chat/db. Implementation is split by domain into the
// modules below; only the names exported before the split are re-exported here.
export { getPool, closePool, openListenerConnection, closeListenerConnection } from "./pool.js";
export { encryptToken, decryptToken, hashSessionToken } from "./crypto.js";
export { runMigrations, rollbackLastMigration, listMigrationFiles, listAppliedMigrations } from "./migrations.js";
export type { MigrationFile, AppliedMigration } from "./migrations.js";
export { runWithAdvisoryLock, saveOAuthPendingState, consumeOAuthPendingState, consumeRateLimit, isRateLimited, checkDatabaseHealth } from "./system.js";
export { WorkspaceNameTakenError, normalizeWorkspaceName, createWorkspace, addWorkspaceMember, isWorkspaceMemberEmail, createWorkspaceInvitation, deleteWorkspaceInvitation, listWorkspaceInvitations, revokeWorkspaceInvitation, acceptWorkspaceInvitation, getWorkspaceById, getWorkspaceByJoinCode, deleteWorkspace, listWorkspacesForUser, listWorkspaceMembers, listWorkspaceMembersWithRoles, getWorkspaceRole, setWorkspaceMemberRole, removeWorkspaceMember, removeWorkspaceMemberAndPersonalIntegrations } from "./workspaces.js";
export type { AcceptWorkspaceInvitationResult } from "./workspaces.js";
export { createConversation, listConversations, renameConversation, setConversationPinned, setConversationArchived, getConversation, deleteConversation, insertMessage, listMessages } from "./conversations.js";
export { notifyWorkspaceMembers, ensurePendingActionNotifications, escalateUnreadDecisionNotifications, createDailyNotificationDigests, listNotifications, markNotificationsRead, markNotificationSelectionRead, getNotificationPreferences, updateNotificationPreferences, notifyWorkspaceUser } from "./notifications.js";
export { getWorkspacePermissionPolicy, setWorkspacePermissionPolicy, hasWorkspacePermission, createPermissionRequest, listPermissionRequests, resolvePermissionRequest } from "./permissions.js";
export { listWorkspaceAgents, getWorkspaceAgent, getPublishedWorkspaceAgent, createWorkspaceAgent, updateWorkspaceAgent, publishWorkspaceAgent, listWorkspaceAgentVersions, deleteWorkspaceAgent } from "./agents.js";
export { listWorkspaceWorkflows, getWorkspaceWorkflow, createWorkspaceWorkflow, updateWorkspaceWorkflow, deleteWorkspaceWorkflow, setWorkflowConversation, createWorkflowRun, finishWorkflowRun, countRecentFailedWorkflowRuns, getObservabilityRetentionPolicy, updateFailureAlertThreshold, updateObservabilityRetentionPolicy, enforceWorkflowRunRetention, listWorkflowRuns, listWorkspaceWorkflowRuns, claimDueWorkflows } from "./workflows.js";
export { listWorkspaceTasks, createWorkspaceTask, updateWorkspaceTask, deleteWorkspaceTask } from "./tasks.js";
export { listWorkspaceMemory, createWorkspaceMemory, updateWorkspaceMemory, getWorkspaceMemory, deleteWorkspaceMemory, workspaceMemoryContext, formatWorkspaceMemoryContext } from "./memory.js";
export { listWorkspaceArtifacts, getWorkspaceArtifact, heartbeatArtifactPresence, createWorkspaceArtifact, updateWorkspaceArtifact, deleteWorkspaceArtifact, setArtifactShareToken, getPublicDashboardByShareToken, getPublicReleaseNotesByShareToken, getPublicArtifactByShareToken, listWorkspaceArtifactComments, createWorkspaceArtifactComment, listWorkspaceArtifactVersions, restoreWorkspaceArtifactVersion } from "./artifacts.js";
export { getUserWorkspacePreference, setUserWorkspacePreference } from "./preferences.js";
export { upsertGithubIntegration, saveGithubOAuthToken, setGithubRepo, upsertSlackIntegration, upsertRemoteMcpIntegration, listIntegrations, getIntegrationCredential, deleteIntegrationForOwner, deletePersonalIntegrationsForUser } from "./integrations.js";
export { createPendingAction, getPendingAction, listPendingActions, resolvePendingAction } from "./pending-actions.js";
export { recordAuditEvent, listAuditEvents } from "./audit.js";
export { upsertUserFromGithub, getUserById, createPasswordUser, getPasswordCredential, upsertUserFromGoogle, createSession, getUserBySessionToken, deleteSession, createEmailVerificationToken, verifyEmailToken, getPasswordCredentialByUserId, createPasswordResetToken, consumePasswordResetToken, updatePasswordHash, deleteSessionsForUser } from "./users.js";
export { REALTIME_CHANNEL, publishRealtimeEvent, getRealtimeEvent, pruneRealtimeEvents, tryAcquireAgentTurnLock, releaseAgentTurnLock } from "./realtime.js";
