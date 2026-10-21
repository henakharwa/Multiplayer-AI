"use client";

import { useEffect, useState } from "react";
import { useDialog } from "../../../_components/DialogProvider";
import { useParams } from "next/navigation";
import type { WorkspaceMember, WorkspaceTask, WorkspaceTaskStatus } from "@mai-chat/shared-types";
import {
  describeError,
  createWorkspaceTask,
  deleteWorkspaceTask,
  listWorkspaceMembers,
  listWorkspaceTasks,
  updateWorkspaceTask,
} from "../../../../lib/api";

const columns: Array<{ status: WorkspaceTaskStatus; label: string }> = [
  { status: "todo", label: "To do" },
  { status: "in_progress", label: "In progress" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];
const blank = { title: "", description: "", ownerUserId: "", dueDate: "" };
const TASK_TITLE_MAX = 200;

export default function TasksPage() {
  const { id: workspaceId } = useParams<{ id: string }>();
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [draft, setDraft] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useDialog();
  const [loading, setLoading] = useState(true);
  // The task being edited in place, and its unsaved field values.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState(blank);
  const [saving, setSaving] = useState(false);
  const refresh = () =>
    Promise.all([listWorkspaceTasks(workspaceId).then(setTasks), listWorkspaceMembers(workspaceId).then(setMembers)])
      .catch((reason: unknown) => setError(describeError(reason, "Could not load tasks.")))
      .finally(() => setLoading(false));
  useEffect(() => {
    void refresh();
  }, [workspaceId]);
  async function create() {
    if (!draft.title.trim()) return;
    setBusy(true);
    setError("");
    try {
      await createWorkspaceTask(workspaceId, {
        title: draft.title,
        description: draft.description,
        ownerUserId: draft.ownerUserId || null,
        dueDate: draft.dueDate || null,
      });
      setDraft(blank);
      await refresh();
    } catch (reason) {
      setError(describeError(reason, "Could not create task."));
    } finally {
      setBusy(false);
    }
  }
  function startEdit(task: WorkspaceTask) {
    setError("");
    setEditingId(task.id);
    setEdit({
      title: task.title,
      description: task.description ?? "",
      ownerUserId: task.ownerUserId ?? "",
      dueDate: task.dueDate ?? "",
    });
  }
  async function saveEdit(task: WorkspaceTask) {
    if (!edit.title.trim()) {
      setError("A task title is required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      // Empty owner or due date clears it (the server treats null as "remove").
      await updateWorkspaceTask(workspaceId, task.id, {
        title: edit.title,
        description: edit.description,
        ownerUserId: edit.ownerUserId || null,
        dueDate: edit.dueDate || null,
      });
      setEditingId(null);
      await refresh();
    } catch (reason) {
      setError(describeError(reason, "Could not update task."));
    } finally {
      setSaving(false);
    }
  }
  async function move(task: WorkspaceTask, status: WorkspaceTaskStatus) {
    try {
      await updateWorkspaceTask(workspaceId, task.id, { status });
      await refresh();
    } catch (reason) {
      setError(describeError(reason, "Could not update task."));
    }
  }
  async function remove(task: WorkspaceTask) {
    if (
      !(await dialog.confirm({
        title: `Delete ${task.title}?`,
        message: "This cannot be undone.",
        confirmLabel: "Delete task",
        danger: true,
      }))
    )
      return;
    try {
      await deleteWorkspaceTask(workspaceId, task.id);
      await refresh();
    } catch (reason) {
      setError(describeError(reason, "Could not delete task."));
    }
  }
  return (
    <main className="workspace-settings-page workspace-tasks-page">
      <header>
        <p className="eyebrow">SHARED EXECUTION</p>
        <h1>Workspace tasks</h1>
        <p>Turn decisions into assigned work. Move tasks through delivery with one shared source of truth.</p>
      </header>
      <section className="task-create">
        <input
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          placeholder="What needs to happen?"
          aria-label="Task title"
          maxLength={TASK_TITLE_MAX}
        />
        <input
          value={draft.description}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          placeholder="Context or acceptance criteria"
          aria-label="Task description"
        />
        <select
          value={draft.ownerUserId}
          onChange={(event) => setDraft({ ...draft, ownerUserId: event.target.value })}
          aria-label="Task owner"
        >
          <option value="">Unassigned</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.displayName}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={draft.dueDate}
          onChange={(event) => setDraft({ ...draft, dueDate: event.target.value })}
          aria-label="Due date"
        />
        <button className="primary-button" disabled={busy || !draft.title.trim()} onClick={() => void create()}>
          {busy ? "Adding…" : "Add task"}
        </button>
      </section>
      {error && <p className="error-text">{error}</p>}
      <section className="task-board" aria-label="Workspace task board">
        {columns.map((column, index) => (
          <div className="task-column" key={column.status}>
            <header>
              <strong>{column.label}</strong>
              <span>{loading ? "…" : tasks.filter((task) => task.status === column.status).length}</span>
            </header>
            {loading && (
              <div className="list-loading" role="status" aria-label="Loading tasks">
                <span />
                <span />
              </div>
            )}
            {tasks
              .filter((task) => task.status === column.status)
              .map((task) =>
                editingId === task.id ? (
                  <article key={task.id} className="task-editing">
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveEdit(task);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setEditingId(null);
                      }}
                    >
                      <label>
                        Title
                        <input
                          value={edit.title}
                          onChange={(event) => setEdit({ ...edit, title: event.target.value })}
                          maxLength={TASK_TITLE_MAX}
                          required
                          autoFocus
                        />
                      </label>
                      <label>
                        Description
                        <textarea
                          rows={2}
                          value={edit.description}
                          onChange={(event) => setEdit({ ...edit, description: event.target.value })}
                          placeholder="Context or acceptance criteria"
                        />
                      </label>
                      <label>
                        Owner
                        <select
                          value={edit.ownerUserId}
                          onChange={(event) => setEdit({ ...edit, ownerUserId: event.target.value })}
                        >
                          <option value="">Unassigned</option>
                          {members.map((member) => (
                            <option key={member.id} value={member.id}>
                              {member.displayName}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Due date
                        <input
                          type="date"
                          value={edit.dueDate}
                          onChange={(event) => setEdit({ ...edit, dueDate: event.target.value })}
                        />
                      </label>
                      <div className="task-edit-actions">
                        <button type="button" className="secondary-button" onClick={() => setEditingId(null)}>
                          Cancel
                        </button>
                        <button type="submit" className="primary-button" disabled={saving || !edit.title.trim()}>
                          {saving ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </form>
                  </article>
                ) : (
                  <article key={task.id}>
                    <h2>{task.title}</h2>
                    {task.description && <p>{task.description}</p>}
                    <footer>
                      <span>
                        {task.ownerName ?? "Unassigned"}
                        {task.dueDate ? ` · Due ${task.dueDate}` : ""}
                      </span>
                      <div>
                        <button
                          disabled={index === 0}
                          onClick={() => void move(task, columns[index - 1].status)}
                          aria-label={`Move ${task.title} back`}
                        >
                          ←
                        </button>
                        <button
                          disabled={index === columns.length - 1}
                          onClick={() => void move(task, columns[index + 1].status)}
                          aria-label={`Move ${task.title} forward`}
                        >
                          →
                        </button>
                        <button
                          className="task-edit"
                          onClick={() => startEdit(task)}
                          aria-label={`Edit ${task.title}`}
                          title="Edit task"
                        >
                          ✎
                        </button>
                        <button
                          className="task-delete"
                          onClick={() => void remove(task)}
                          aria-label={`Delete ${task.title}`}
                        >
                          ×
                        </button>
                      </div>
                    </footer>
                  </article>
                ),
              )}
          </div>
        ))}
      </section>
    </main>
  );
}
