"use client";

export type PlanVisualLayout = "execution";
export const planVisualLayouts: Array<{ id: PlanVisualLayout; label: string; detail: string }> = [{ id: "execution", label: "Execution plan", detail: "Readiness, workstreams, and delivery board" }];

type Task = { index: number; done: boolean; label: string };
type Section = { title: string; lines: string[] };
function clean(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /^[-| :]+$/.test(trimmed)) return "";
  const cells = trimmed.startsWith("|") && trimmed.endsWith("|") ? trimmed.split("|").slice(1, -1).map((cell) => cell.trim()).filter(Boolean).join(" · ") : trimmed;
  return cells.replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").replace(/^\[[ xX]\]\s*/, "").replace(/(\*\*|__|`|~~)/g, "").replace(/\s+/g, " ").trim();
}
function parse(content: string) {
  const chunks = content.split(/^##\s+/m).filter(Boolean);
  const sections: Section[] = chunks.map((chunk) => { const [title, ...rest] = chunk.split("\n"); return { title: clean(title) || "Plan detail", lines: rest.map(clean).filter(Boolean) }; }).filter((section) => section.lines.length || section.title !== "Plan detail");
  const tasks = [...content.matchAll(/^\s*[-*+]\s+\[([ xX])\]\s*(.+)$/gm)].map((match, index) => ({ index, done: /[xX]/.test(match[1]), label: clean(match[2]) }));
  return { sections: sections.length ? sections : [{ title: "Plan", lines: ["Add plan details to build this view."] }], tasks };
}
function Lines({ lines }: { lines: string[] }) { return <ul>{lines.slice(0, 5).map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ul>; }
function TaskLines({ tasks, onToggleTask, empty }: { tasks: Task[]; onToggleTask?: (index: number) => void; empty: string }) { return <ul className="plan-task-lines">{tasks.length ? tasks.slice(0, 6).map((task) => <li key={task.index}><label><input type="checkbox" checked={task.done} onChange={() => onToggleTask?.(task.index)} disabled={!onToggleTask} /><span>{task.label}</span></label></li>) : <li>{empty}</li>}</ul>; }
export function PlanVisual({ title, summary, content, layout: _layout, onToggleTask }: { title: string; summary: string; content: string; layout: PlanVisualLayout; onToggleTask?: (index: number) => void }) {
  const data = parse(content); const done = data.tasks.filter((task) => task.done); const todo = data.tasks.filter((task) => !task.done);
  const progress = data.tasks.length ? Math.round(done.length / data.tasks.length * 100) : 0;
  const risks = data.sections.find((section) => /risk|blocker/i.test(section.title))?.lines ?? ["No active risks captured."];
  const inProgress = todo.slice(0, Math.ceil(todo.length / 2)); const review = todo.slice(Math.ceil(todo.length / 2));
  return <section className="plan-visual plan-visual-execution">
    <header><p>SHARED DELIVERY PLAN</p><h2>{title || "Untitled plan"}</h2><span>{summary || "A focused, shared view of the work ahead."}</span></header>
    <section className="plan-scorecard"><article className="score-health"><span>LAUNCH READINESS</span><b>{progress}%</b><small>{done.length}/{data.tasks.length} complete · {progress >= 70 ? "On track" : "Needs attention"}</small></article><article><span>OPEN WORK</span><strong>{todo.length}</strong><small>checklist items remain</small></article><article><span>RISKS</span><strong>{risks.length}</strong><small>items to mitigate</small></article><article><span>NEXT ACTION</span><p>{todo[0]?.label || "Define the next action."}</p></article></section>
    <section className="execution-heading"><span>WORKSTREAMS</span><h3>Areas of ownership</h3></section>
    <div className="plan-workstreams">{data.sections.slice(0, 6).map((section, index) => <article key={`${section.title}-${index}`}><span>WORKSTREAM {index + 1}</span><h3>{section.title}</h3><Lines lines={section.lines} /></article>)}</div>
    <section className="execution-heading"><span>DELIVERY BOARD</span><h3>Work in motion</h3><small>Tick an item to update the plan and readiness score.</small></section>
    <div className="plan-kanban"><article><h3>To do</h3><TaskLines tasks={todo} onToggleTask={onToggleTask} empty="No open tasks." /></article><article><h3>In progress</h3><TaskLines tasks={inProgress} onToggleTask={onToggleTask} empty="Move work here when started." /></article><article><h3>Review</h3><TaskLines tasks={review} onToggleTask={onToggleTask} empty="No items awaiting review." /></article><article><h3>Done</h3><TaskLines tasks={done} onToggleTask={onToggleTask} empty="Nothing completed yet." /></article></div>
  </section>;
}
