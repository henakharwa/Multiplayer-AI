"use client";

export type PlanVisualLayout = "roadmap" | "brief" | "workstreams" | "canvas" | "gantt";

const layouts: Array<{ id: PlanVisualLayout; label: string; detail: string }> = [
  { id: "roadmap", label: "Roadmap", detail: "Phases and milestones" },
  { id: "brief", label: "Executive brief", detail: "A concise leadership update" },
  { id: "workstreams", label: "Workstreams", detail: "Parallel areas of ownership" },
  { id: "canvas", label: "Plan canvas", detail: "Goals, risks, and measures" },
  { id: "gantt", label: "Delivery timeline", detail: "A Gantt-style view" },
];
export { layouts as planVisualLayouts };

type Section = { title: string; lines: string[] };
function parse(content: string) {
  const chunks = content.split(/^##\s+/m).filter(Boolean);
  const sections: Section[] = chunks.map((chunk) => { const [title, ...rest] = chunk.split("\n"); return { title: title.trim() || "Plan detail", lines: rest.map((line) => line.replace(/^[-*]\s+/, "").replace(/^\[[ xX]\]\s*/, "").trim()).filter(Boolean) }; });
  const tasks = [...content.matchAll(/^-\s+\[([ xX])\]\s*(.+)$/gm)].map((match) => ({ done: /[xX]/.test(match[1]), label: match[2] }));
  const firstLines = sections.flatMap((section) => section.lines).filter(Boolean);
  return { sections: sections.length ? sections : [{ title: "Plan", lines: firstLines.length ? firstLines : ["Add plan details to build this view."] }], tasks, firstLines };
}
function Lines({ lines }: { lines: string[] }) { return <ul>{lines.slice(0, 5).map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ul>; }
export function PlanVisual({ title, summary, content, layout }: { title: string; summary: string; content: string; layout: PlanVisualLayout }) {
  const data = parse(content); const progress = data.tasks.length ? Math.round(data.tasks.filter((task) => task.done).length / data.tasks.length * 100) : 0;
  const phases = (data.tasks.length ? data.tasks.map((task) => task.label) : data.firstLines).slice(0, 5);
  return <section className={`plan-visual plan-visual-${layout}`}>
    <header><p>SHARED DELIVERY PLAN</p><h2>{title || "Untitled plan"}</h2><span>{summary || "A focused, shared view of the work ahead."}</span></header>
    {layout === "roadmap" && <div className="plan-roadmap">{phases.map((phase, index) => <article key={`${phase}-${index}`}><b>0{index + 1}</b><i /><h3>{phase}</h3><small>{index === 0 ? "Now" : `Phase ${index + 1}`}</small></article>)}</div>}
    {layout === "brief" && <div className="plan-brief"><article className="plan-brief-main"><h3>Outcome</h3><p>{data.sections[0]?.lines[0] || summary || "Set the outcome for this plan."}</p><div className="plan-progress"><i style={{ width: `${progress}%` }} /></div><small>{progress}% checklist completion</small></article><article><h3>Next steps</h3><Lines lines={phases} /></article><article><h3>Watch items</h3><Lines lines={data.sections.find((section) => /risk|blocker/i.test(section.title))?.lines ?? ["No risks documented yet."]} /></article></div>}
    {layout === "workstreams" && <div className="plan-workstreams">{data.sections.slice(0, 6).map((section, index) => <article key={`${section.title}-${index}`}><span>WORKSTREAM {index + 1}</span><h3>{section.title}</h3><Lines lines={section.lines} /></article>)}</div>}
    {layout === "canvas" && <div className="plan-canvas"><article className="canvas-objective"><span>OBJECTIVE</span><h3>{data.sections[0]?.lines[0] || summary || "Define the destination."}</h3></article><article><span>MEASURES</span><Lines lines={data.sections.find((section) => /metric|success|measure/i.test(section.title))?.lines ?? phases.slice(0, 3)} /></article><article><span>RISKS</span><Lines lines={data.sections.find((section) => /risk|blocker/i.test(section.title))?.lines ?? ["Capture delivery risks."]} /></article><article><span>COMMITMENTS</span><div className="canvas-progress"><b>{progress}%</b><small>complete</small></div></article></div>}
    {layout === "gantt" && <div className="plan-gantt"><div className="gantt-axis"><span>Now</span><span>Next</span><span>Later</span><span>Launch</span></div>{phases.map((phase, index) => <article key={`${phase}-${index}`}><strong>{phase}</strong><div><i style={{ marginLeft: `${index * 9}%`, width: `${Math.max(33, 70 - index * 7)}%` }} /></div></article>)}</div>}
  </section>;
}
