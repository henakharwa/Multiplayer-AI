"use client";
export function ReportVisual({ title, summary, content }: { title: string; summary: string; content: string }) {
  const groups = content
    .split(/^##\s+/m)
    .filter(Boolean)
    .map((part) => {
      const [title, ...lines] = part.split("\n");
      return {
        title: title.replace(/^#+\s*/, ""),
        items: lines.map((x) => x.replace(/^[-*+]\s+|\*\*/g, "").trim()).filter((x) => x && !/^[-| :]+$/.test(x)),
      };
    });
  const all = groups.flatMap((group) => group.items);
  const decisions = groups.filter((group) => /decision|ask/i.test(group.title)).flatMap((group) => group.items);
  const decisionCandidates = [
    ...new Map(
      [
        ...decisions,
        ...all.filter((item) => /\b(decide|decision|approve|confirm|choose|go.no.go|owner)\b/i.test(item)),
      ].map(
        (item) =>
          [
            item
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, " ")
              .trim(),
            item,
          ] as const,
      ),
    ).values(),
  ];
  const next = groups.filter((group) => /next|action/i.test(group.title)).flatMap((group) => group.items);
  return (
    <section className="report-visual report-decision-timeline">
      <header>
        <p>TEAM REPORT · DECISION TIMELINE</p>
        <h2>{title || "Untitled report"}</h2>
        <span>{summary || "A concise update for the team."}</span>
      </header>
      <section className="report-decision-briefing">
        <div className="report-section-title">
          <span>DECISION BRIEFING</span>
          <h3>Choices and approvals required</h3>
        </div>
        <div className="report-decision-list">
          {(decisionCandidates.length ? decisionCandidates : all.slice(0, 3)).slice(0, 4).map((item, index) => (
            <article key={`${item}-${index}`}>
              <b>D{index + 1}</b>
              <div>
                <span>DECISION REQUIRED</span>
                <p>{item}</p>
              </div>
              <small>{index === 0 ? "Owner: report lead · Due next" : "Owner: team · Review this week"}</small>
            </article>
          ))}
        </div>
      </section>
      <section className="report-section-title report-timeline-title">
        <span>PROGRESS TIMELINE</span>
        <h3>What changed and what happens next</h3>
      </section>
      <section className="report-timeline">
        {all.map((item, index) => (
          <article key={`${item}-${index}`}>
            <i />
            <span>{index === 0 ? "Completed" : index === all.length - 1 ? "Next" : "In progress"}</span>
            <p>{item}</p>
          </article>
        ))}
      </section>
      {next.length > 0 && (
        <section className="report-next-action">
          <span>NEXT ACTION</span>
          <p>{next[0]}</p>
        </section>
      )}
    </section>
  );
}
