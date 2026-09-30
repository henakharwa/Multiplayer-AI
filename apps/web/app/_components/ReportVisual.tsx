"use client";
export type ReportVisualLayout = "brief" | "scorecard" | "weekly" | "risks" | "progress" | "narrative";
export const reportVisualLayouts: Array<{id: ReportVisualLayout; label: string; detail: string}> = [
  {id:"brief",label:"Executive brief",detail:"Highlights and next step"},{id:"scorecard",label:"Metric scorecard",detail:"Key measures at a glance"},{id:"weekly",label:"Weekly update",detail:"Wins, work, and blockers"},{id:"risks",label:"Risk & decisions",detail:"Focus on what needs action"},{id:"progress",label:"Team progress",detail:"Workstream progress cards"},{id:"narrative",label:"Narrative report",detail:"Polished stakeholder readout"},
];
function lines(content:string){return content.split(/\r?\n/).map(x=>x.replace(/^#{1,6}\s+|^[-*+]\s+|\*\*/g,"").trim()).filter(x=>x && !/^[-| :]+$/.test(x)).slice(0,12)}
export function ReportVisual({title,summary,content,layout}:{title:string;summary:string;content:string;layout:ReportVisualLayout}){const items=lines(content); const cards=items.slice(0,4); return <section className={`report-visual report-${layout}`}><header><p>TEAM REPORT</p><h2>{title||"Untitled report"}</h2><span>{summary||"A concise update for the team."}</span></header>
{layout==="brief"&&<div className="report-brief"><article><b>EXECUTIVE SUMMARY</b><p>{items[0]||"Add report context to create a summary."}</p></article><article><b>NEXT STEP</b><p>{items[1]||"Identify the next decision."}</p></article></div>}
{layout==="scorecard"&&<div className="report-scorecard">{cards.map((x,i)=><article key={x}><span>METRIC 0{i+1}</span><strong>{i===0?"On track":i===1?"75%":"Active"}</strong><small>{x}</small></article>)}</div>}
{layout==="weekly"&&<div className="report-weekly"><article><h3>Wins</h3><ul>{cards.slice(0,2).map(x=><li key={x}>{x}</li>)}</ul></article><article><h3>In progress</h3><ul>{cards.slice(2).map(x=><li key={x}>{x}</li>)}</ul></article><article><h3>Blockers</h3><p>{items.find(x=>/risk|block|need/i.test(x))||"No blockers recorded."}</p></article></div>}
{layout==="risks"&&<div className="report-risks">{cards.map((x,i)=><article key={x}><span className={`report-dot level-${i%3}`}/><div><b>{i%2?"Decision needed":"Watch item"}</b><p>{x}</p></div><small>{i%2?"This week":"Monitor"}</small></article>)}</div>}
{layout==="progress"&&<div className="report-progress">{cards.map((x,i)=><article key={x}><span>WORKSTREAM {i+1}</span><p>{x}</p><div><i style={{width:`${78-i*14}%`}}/></div></article>)}</div>}
{layout==="narrative"&&<article className="report-narrative"><h3>What changed</h3>{items.slice(0,6).map(x=><p key={x}>{x}</p>)}</article>}
</section>}
