"use client";

export type PlanVisualLayout = "execution";
export const planVisualLayouts: Array<{ id: PlanVisualLayout; label: string; detail: string }> = [
  { id: "execution", label: "Execution plan", detail: "Readiness, workstreams, and delivery board" },
];

type Section = { title: string; lines: string[] };
function parse(content: string) {
  const chunks = content.split(/^##\s+/m).filter(Boolean);
  const sections: Section[] = chunks.map((chunk) => { const [title, ...rest] = chunk.split("\n"); return { title: title.trim() || "Plan detail", lines: rest.map((line) => line.replace(/^[-*]\s+/, "").replace(/^\[[ xX]\]\s*/, "").trim()).filter(Boolean) }; });
  const tasks = [...content.matchAll(/^-\s+\[([ xX])\]\s*(.+)$/gm)].map((match) => ({ done: /[xX]/.test(match[1]), label: match[2] }));
  return { sections: sections.length ? sections : [{ title: "Plan", lines: ["Add plan details to build this view."] }], tasks };
}
function Lines({ lines }: { lines: string[] }) { return <ul>{lines.slice(0, 5).map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ul>; }
export function PlanVisual({ title, summary, content }: { title: string; summary: string; content: string; layout: PlanVisualLayout }) {
  const data = parse(content); const done = data.tasks.filter((task) => task.done).map((task) => task.label); const todo = data.tasks.filter((task) => !task.done).map((task) => task.label);
  const progress = data.tasks.length ? Math.round(done.length / data.tasks.length * 100) : 0;
  const risks = data.sections.find((section) => /risk|blocker/i.test(section.title))?.lines ?? ["No active risks captured."];
  const inProgress = todo.slice(0, Math.ceil(todo.length / 2)); const review = todo.slice(Math.ceil(todo.length / 2));
  return <section className="plan-visual plan-visual-execution">
    <header><p>SHARED DELIVERY PLAN</p><h2>{title || "Untitled plan"}</h2><span>{summary || "A focused, shared view of the work ahead."}</span></header>
    <section className="plan-scorecard"><article className="score-health"><span>LAUNCH READINESS</span><b>{progress}%</b><small>{progress >= 70 ? "On track" : "Needs attention"}</small></article><article><span>OPEN WORK</span><strong>{todo.length}</strong><small>checklist items remain</small></article><article><span>RISKS</span><strong>{risks.length}</strong><small>items to mitigate</small></article><article><span>NEXT ACTION</span><p>{todo[0] || "Define the next action."}</p></article></section>
    <section className="execution-heading"><span>WORKSTREAMS</span><h3>Areas of ownership</h3></section>
    <div className="plan-workstreams">{data.sections.slice(0, 6).map((section, index) => <article key={`${section.title}-${index}`}><span>WORKSTREAM {index + 1}</span><h3>{section.title}</h3><Lines lines={section.lines} /></article>)}</div>
    <section className="execution-heading"><span>DELIVERY BOARD</span><h3>Work in motion</h3></section>
    <div className="plan-kanban"><article><h3>To do</h3><Lines lines={todo.length ? todo : ["No open tasks."]} /></article><article><h3>In progress</h3><Lines lines={inProgress.length ? inProgress : ["Move work here when started."]} /></article><article><h3>Review</h3><Lines lines={review.length ? review : risks.slice(0, 2)} /></article><article><h3>Done</h3><Lines lines={done.length ? done : ["Nothing completed yet."]} /></article></div>
  </section>;
}
