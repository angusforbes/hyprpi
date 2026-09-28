# The project board: plan

Status: **plan, not built** (2026-09-28, Blink with Angus). Related workshop work:
`~/Obsidian/Tinker/2026-09-28 Moving a project.md` (pi·loij, pi·ze03) and
`~/Obsidian/Tinker/2026-09-28 Decision-needed signal.md` (pi·loij, commits 915badd, 3d477e3).

## Why

So agents can work *with* Angus without him hunting for them across workspaces. The
board is his external working memory: in five seconds it says **what needs me, what's
moving, what's next**. Agents keep it current and talk to each other to do so. The
stream shows what happened; the board shows where things stand. It is an edited
page, not a stream.

## Shape

- **One board per world** (room C has board C). A board holds **several projects**, one card each.
- A project has a **stable id** (`p-7k2m`) and a renameable **slug** used as `@hyprpi-boards`.
  Projects and agents share one `@` namespace: names are unique across both. Completion marks
  projects 📋.
- A card belongs to exactly one world at a time; **spinning out** moves it (with its agents and a
  pointer to its history) to another world (pi·ze03's proposal; `board.moveCard(id, from, to)` hook).
  Whole-room moves are out.
- Projects can **split** (into two or more) and **merge**.

### A card

```
━ 📋 hyprpi-boards ─────────── writer @Blink · members @Blink @Lippy · updated 14:32
  Where   @Names done in both panels; board design in progress
  Decide  D1 ▸ … A (recommended) · B · going with A unless you say otherwise
  Next    N1 ▸ board storage + tools   N2 ▸ Ctrl+B view
  Heard   H1 ▸ … (highest priority first, all of them for now)
  Done    ✓1 /tinker (verified: …)   ✓2 @Names
```

- **Sections:** Where (one line: where things stand) · Decide (waiting on Angus) · Next ·
  Heard (everything Angus says, distilled) · Done (with how it was verified).
- **Handles:** each item's short label, section letter + number: `D1`, `N2`, `H3`, `✓4`. A handle
  stays with its item when the text changes and is **never reused**, so it can't change
  meaning under you.
- **Decide items are choices,** not open questions: options, a recommendation, a default. If
  the decision isn't blocking, the agent carries on with the default.
- **Heard you say** = everything Angus says to the project's agents (room posts, prompts,
  dictation), not just what he marks. Ordered by priority, all shown; trim later if busy. Agents
  turn items into Next / Decide items (so he sees what they understood) or remove them once
  dealt with.
- Every item shows its **age and author**; stale items are flagged.
- **Top of the board:** a **Needs you** strip (every open Decide item on this board).
- **Since you left:** opening a card he hasn't looked at for a while shows ~3 lines of what changed.
- **Next first step:** each project keeps one concrete step to resume with.
- Card states: new (made by an agent, badge) · active · paused · archived · ⚠ nobody on it.

## Membership

- **Agents define their own projects**, or Angus defines one and assigns agents. After that
  agents join and leave freely to reflect what they actually do.
- **Leaving** requires a hand-off note to the remaining members (the daemon delivers it) plus a
  card update. The last one out leaves ⚠.
- **Writer:** the agent that writes a combined answer into the card. Default: the **first agent
  assigned**. Members can hand the role on; the card header shows who has it.
- The card is the source of truth; the daemon keeps an in-memory agent → projects index.

## Talking to a project

| Where | Typed | Effect |
|---|---|---|
| room | `@hyprpi-boards text` | to the project's current members (like a group). They reply however fits. The room message is tagged with the project id. |
| board | `@hyprpi-boards text` | the same members, framed as "update the board": they coordinate (talk), the writer edits the card, nothing in the room |
| board | `@hyprpi-boards` alone | **one combined view**: the card expanded, plus who (each member and what it's doing now) and recent changes. Nothing sent |
| board | `@hyprpi-boards D1 b` | answers a decision (also a single key on the Needs-you strip) |
| board | `@hyprpi-boards N2 ?` | more detail on that item, written into the card |

## Board commands

- `/clarify @p D1 question` · `/refresh [@p]` (members reconcile the card with reality)
- `/todo @p text` · `/note @p text` (Angus's own entries, verbatim) · `/done @p N2` · `/drop @p N2`
- `/new @name [what] [+@Agent…]` · `/assign @p +@A -@B` · `/rename @p @new`
- `/split @p` (members propose, as a Decide item) · `/split @p into @a @b` · `/merge @a @b [into @c]`
- `/spinout @p WORLD` (pi·ze03's design) · `/pause @p` · `/archive @p`

`/focus`, `/who` and `/history` are not needed: `@project` alone shows all three.

## Signals (three sounds, three meanings)

- **ding**: a decision is needed from Angus. Fires **right away** when a Decide item is added
  (daemon `dingFor(a, text, { itemId })`, commit 3d477e3; shell `ding "text"`); resolving
  it calls `clearDing(a, itemId)`, which clears the agent's × when it has no other open decisions.
- **bonk**: Angus asked to be told something, or an agent judges it urgent (mid-timing/testing).
- **chime**: an agent went from working to idle/done.
- **No quiet mode.** Silence reads as "stuck"; agents narrate.

## Working agreement for agents (goes into the board tools' guidelines)

1. Don't ask Angus what you can find out, or decide in a way that can be undone: pick the default, note it on the card.
2. Ask him only about things that can't be undone, taste, direction, money, or sending things out, as a one-line choice with your recommendation.
3. Ask a peer (project members, `talk`) before asking Angus.
4. Ding for decisions, bonk only when urgent; everything else goes on the board.
5. When you finish something, write the **verified** result on the card (and how it was verified).
6. Leave a next first step before you stop. Narrate while working.

## Pieces

- **Storage (daemon):** `~/.local/state/hyprpi/boards/<room>.json` + an append-only change log per
  board. Methods `board.get / board.update / board.project.* / board.request`; broadcast
  `board` events to panels.
- **Agent tools (pi-extension):** `board_read`, `board_update` (add / edit / done / drop an item,
  set Where / next step), `project_join` / `project_leave` (with hand-off note), `project_create`.
- **Routing:** `@project` in the room → members (message tagged `project: id`); board requests →
  members with the "update the card, writer writes, no room post" framing.
- **Room panel view:** Ctrl+B toggles board ⇄ stream. In board mode `@` completes projects
  (📋) and items (`@p D1`), and the box takes board commands.
- **Signals:** Decide added → `dingFor` (loij's hook); resolved → `clearDing`.

## Build order

1. Storage + daemon methods + change log.
2. Agent tools + working agreement; agents can create and fill cards.
3. Ctrl+B view: Needs-you strip, cards, handles, `@project` combined view.
4. `@project` routing in the room and board requests (writer coordination).
5. Decide with options + ding + answering by key; /todo /note /done /drop.
6. Membership commands, split/merge, since-you-left, next first step.
7. Hand spin-out the `board.moveCard` hook (pi·ze03).

## Open questions

See the end of the conversation of 2026-09-28; answered ones are folded in above.
