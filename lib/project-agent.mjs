// J644 (Angus: "T1 seems reasonable to me", T2a: the handbook becomes the rule once he's read it): the essentials of Tangle's
// project agent handbook, ~/Obsidian/Notes/Project agent handbook.md (Tangle keeps it current; it is the one source of truth,
// this is its short summary and points to it). Shown only to project owners: the pi extension adds it to the system prompt of
// an agent that is the writer of a project (catch-all cards included: Angus 66b, "for now") (pi-extension/index.ts, before_agent_start). Promotion (J622
// thoughts.promote) tells the new owner to read the full note.
export const HANDBOOK = "~/Obsidian/Notes/Project agent handbook.md";
export const PROJECT_AGENT_SECTION = [
  `# You are a project agent (handbook: ${HANDBOOK}; read it in full once)`,
  "- Words: project agents, task agents, Thoughts. Nothing else.",
  "- You and your project are one thing: same name, same icon; you are made with the project and remember it as it grows. You are Angus's conversation partner for it; Thoughts is over all projects and handles one-offs.",
  "- Accountable: check before you state anything that feeds a decision or plan (run it, read it, look). If you can't, say where it came from and that it's unverified. Keep seen, told and guessed apart; correct mistakes where you made them.",
  "- Questions to Angus: numbered (1, 2; options 1a, 1b), recommendation marked \"(recommended)\"; a repeated question keeps its number and labels; when he asks, give every open question in one list with fixed labels; facts, cautions and steps get F1, C1, S1. One short reply, no \"still open\" tails; decisions go on the card as decide items.",
  "- One key answers each question (rule 11): every question on one line as `rc1: question? (y/n)` or `rc1: question? a. one, b. two`, so Angus replies \"rc1 y\" or \"rc1 b\"; the label is your project's short lowercase code plus a number (rc for remote-control, v for vibezai, fm for flow-mode; a longer code such as vai if two would clash), always there, even for a single question; options only for choices; a relayed question keeps its agent's label.",
  "- Reports and handoffs go in your project's folder, ~/Obsidian/Projects/<project>/ (the card links to it); a task agent working for you sends you a one-line digest after each decision.",
  "- Delegate by size: more than a few tool calls, long output or parallel work goes to task agents (yours, briefed with Angus's own words, closed when their report is in); tiny edits and the conversation stay with you. Show a report once, not twice.",
  "- Work for your project reaches you through Thoughts asking you (D2), not through Thoughts' own helpers.",
  "- Awareness (P9): after a turn that changes a decision, a plan or the work, one line to Thoughts (talk). Anything touching other projects: ask Thoughts.",
  "- The card: look it up when you need it (you're told when it changes). Turn what Angus says into card items as he says it; keep \"where\" to one line and leave a next step. No live agent = parked (grey); reviving you unparks it.",
  "- Writing: short replies, his words verbatim in notes; Markdown with one line per paragraph and narrow tables.",
].join("\n");

// The section for agent `id`, given its world's board projects: the essentials plus the projects it owns, or "" when it owns
// none. Writers of catch-all and shared cards (@workshop, inbox-x) count too (Angus 66b: they get their own agent "for now";
// the inbox cards' writer is Thoughts, which this never matches). Archived projects don't count.
export function sectionFor(id, projects = []) {
  const mine = (projects || []).filter((pr) => pr && pr.writer === id && pr.status !== "archived").map((pr) => pr.name);
  return mine.length ? `${PROJECT_AGENT_SECTION}\n(You own ${mine.map((n) => "@" + n).join(", ")}.)` : "";
}

// J651 (Angus: "amend the handoff command so that it includes the idea of tasks writing a report directly in the project folder
// (if it's a project-task agent or project-agent)"; P12, T17a+d+e): every project keeps its reports and handoffs in
// ~/Obsidian/Projects/<name>/, and its card links to that folder. Which project an agent works for:
//   owner: it is the writer of a (non-archived) project in its world -> that project (the most recently updated one);
//   task:  it is a spawned child whose parent (a project agent) owns one -> the parent's project;
//   none:  anything else (a loose agent keeps today's handoff).
export const PROJECTS_ROOT = "~/Obsidian/Projects";
export const projectFolder = (name) => `${PROJECTS_ROOT}/${name}`;
export function projectOf(id, { projects = [], parentOf = () => "" } = {}) {
  const own = (who) => (projects || []).filter((pr) => pr && pr.writer === who && pr.status !== "archived" && !/^thoughts:/.test(pr.writer || ""))
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))[0] || null;
  const mine = own(id);
  if (mine) return { project: mine.name, id: mine.id, folder: projectFolder(mine.name), role: "owner" };
  const parent = parentOf(id);
  const theirs = parent ? own(parent) : null;
  if (theirs) return { project: theirs.name, id: theirs.id, folder: projectFolder(theirs.name), role: "task", parent };
  return null;
}
