"use client";

export type PlanVisualLayout = "execution";
export const planVisualLayouts: Array<{ id: PlanVisualLayout; label: string; detail: string }> = [{ id: "execution", label: "Execution plan", detail: "Readiness, workstreams, and delivery board" }];

type TaskStage = "todo" | "progress" | "review" | "done";
type Task = { index: number; stage: TaskStage; label: string };
type Section = { title: string; lines: string[] };
function clean(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /^[-| :]+$/.test(trimmed)) return "";
  const cells = trimmed.startsWith("|") && trimmed.endsWith("|") ? trimmed.split("|").slice(1, -1).map((cell) => cell.trim()).filter(Boolean).join(" · ") : trimmed;
  return cells.replace(/<!--plan-stage:(todo|progress|review|done)-->/g, "").replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+/, "").replace(/^\d+\s*[.)·]\s*/, "").replace(/^\[[ xX]\]\s*/, "").replace(/(\*\*|__|`|~~|\*)/g, "").replace(/[□☐]/g, "").replace(/\bTBD\b/gi, "").replace(/\s*[·|]\s*(?=[·|]|$)/g, "").replace(/\s+/g, " ").replace(/^[-·\s]+|[-·\s]+$/g, "").trim();
}
function parse(content: string) {
  const chunks = content.split(/^##\s+/m).filter(Boolean);
  const sections: Section[] = chunks.map((chunk) => { const [title, ...rest] = chunk.split("\n"); return { title: clean(title) || "Plan detail", lines: rest.map(clean).filter(Boolean) }; }).filter((section) => section.lines.length || section.title !== "Plan detail");
  const tasks = [...content.matchAll(/^\s*[-*+]\s+\[([ xX])\]\s*(.+)$/gm)].map((match, index) => { const stage = /<!--plan-stage:(todo|progress|review|done)-->/.exec(match[2])?.[1] as TaskStage | undefined; return { index, stage: stage ?? (/[xX]/.test(match[1]) ? "done" : "todo"), label: clean(match[2]) }; }).filter((task) => task.label);
  return { sections: sections.length ? sections : [{ title: "Plan", lines: ["Add plan details to build this view."] }], tasks };
}
function Lines({ lines }: { lines: string[] }) { return <ul>{lines.slice(0, 5).map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ul>; }
function TaskLines({ tasks, onAdvanceTask, empty }: { tasks: Task[]; onAdvanceTask?: (index: number, direction: "next" | "previous") => void; empty: string }) { return <ul className="plan-task-lines">{tasks.length ? tasks.slice(0, 6).map((task) => <li key={task.index}><label><input type="checkbox" checked={task.stage === "done"} onChange={() => onAdvanceTask?.(task.index, task.stage === "done" ? "previous" : "next")} disabled={!onAdvanceTask} aria-label={`Move ${task.label} to the next stage`} /><span>{task.label}</span></label></li>) : <li>{empty}</li>}</ul>; }
export function PlanVisual({ title, summary, content, layout: _layout, onAdvanceTask }: { title: string; summary: string; content: string; layout: PlanVisualLayout; onAdvanceTask?: (index: number, direction: "next" | "previous") => void }) {
  const data = parse(content); const done = data.tasks.filter((task) => task.stage === "done"); const todo = data.tasks.filter((task) => task.stage === "todo");
  const progress = data.tasks.length ? Math.round(done.length / data.tasks.length * 100) : 0;
  const risks = data.sections.find((section) => /risk|blocker/i.test(section.title))?.lines ?? ["No active risks captured."];
  const inProgress = data.tasks.filter((task) => task.stage === "progress"); const review = data.tasks.filter((task) => task.stage === "review");
  const nextAction = todo[0] ? `Start ${todo[0].label} and move it to In progress.` : inProgress[0] ? `Continue ${inProgress[0].label}, then move it to Review.` : review[0] ? `Review ${review[0].label} and mark it Done when approved.` : "All planned work is complete. Confirm launch readiness with the team.";
  return <section className="plan-visual plan-visual-execution">
    <header><p>SHARED DELIVERY PLAN</p><h2>{title || "Untitled plan"}</h2><span>{summary || "A focused, shared view of the work ahead."}</span></header>
    <section className="plan-scorecard"><article className="score-health"><span>LAUNCH READINESS</span><b>{progress}%</b><small>{done.length}/{data.tasks.length} complete · {progress >= 70 ? "On track" : "Needs attention"}</small></article><article><span>OPEN WORK</span><strong>{todo.length}</strong><small>checklist items remain</small></article><article><span>RISKS</span><strong>{risks.length}</strong><small>items to mitigate</small></article><article><span>NEXT ACTION</span><p>{nextAction}</p></article></section>
    <section className="execution-heading"><span>WORKSTREAMS</span><h3>Areas of ownership</h3></section>
    <div className="plan-workstreams">{data.sections.slice(0, 6).map((section, index) => <article key={`${section.title}-${index}`}><span>WORKSTREAM {index + 1}</span><h3>{section.title}</h3><Lines lines={section.lines} /></article>)}</div>
    <section className="execution-heading"><span>DELIVERY BOARD</span><h3>Work in motion</h3><small>Tick an item to update the plan and readiness score.</small></section>
    <div className="plan-kanban"><article><h3>To do</h3><TaskLines tasks={todo} onAdvanceTask={onAdvanceTask} empty="No open tasks." /></article><article><h3>In progress</h3><TaskLines tasks={inProgress} onAdvanceTask={onAdvanceTask} empty="Move work here when started." /></article><article><h3>Review</h3><TaskLines tasks={review} onAdvanceTask={onAdvanceTask} empty="No items awaiting review." /></article><article><h3>Done</h3><TaskLines tasks={done} onAdvanceTask={onAdvanceTask} empty="Nothing completed yet." /></article></div>
  </section>;
}
