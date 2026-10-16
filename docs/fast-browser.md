# Fast browsing in Angus's Brave (J669)

Angus (2026-10-15): "ok can you go faster? … https://github.com/shhivv/arc-cua … ok yes let's figuer out how to make you fast", then "basically it seom integration of Jev … the osx c.u. libray uses Jev internlly i think to browse fast", then "ok go ahead restart brev so you can browse fast".

## How arc-cua gets its speed (W1)

arc-cua is two tools in one package (read from its code, commit in /tmp clone of github.com/shhivv/arc-cua):

- arc-driver, the fast part. It never looks at pixels to act. For macOS apps it reads the accessibility tree (pyobjc ApplicationServices) and acts on elements by id. For Chrome (src/arc_cua/backends/chrome.py, cdp.py, chrome_page.js) it uses the Chrome DevTools Protocol: a small script injected with Runtime.evaluate lists the visible elements with stable ids, and actions go in with Input.dispatchMouseEvent / Input.dispatchKeyEvent, so the window can stay in the background and the user's pointer is untouched. It also waits for the page to settle (a MutationObserver plus tracked network requests) instead of fixed sleeps, and refuses an action if the page changed since it looked.
- arc-cua, the decision loop. A planner hands it a bounded subtask; a fast decision model picks each next action from the list of actions the page actually offers.

Its own benchmark (BENCHMARKS.md): a click 217 ms vs 1.1 s, a 2-field form 1.85 s vs 15 s, against cua-driver, which goes element first, then a fresh look, then pixels (BENCHMARKS.md).

## What "Jev" is (W5)

JEV is not a browser technique: it is TypeSafe's SystemOne decision model ("jev-latest", https://api.typesafe.ai/v1/systemone; src/arc_cua/policies/typesafe.py, class TypeSafeTransport, name = "JEV"). arc-cua asks it typed multiple-choice questions ("which element, which operation") about the structured page state and gets a choice with probabilities back, which is much faster and cheaper than a frontier model reasoning over a screenshot for every click. The driver itself uses no JEV.

So arc-cua's speed has two sources, and both exist on Linux:

| arc-cua (macOS)         | here (Linux, Brave)          |
|-------------------------|------------------------------|
| CDP on Chrome           | CDP on Brave, port 9222      |
| AX tree for apps        | AT-SPI (hyprcu ui/click_ui)  |
| JEV decision model      | JEV via jev_evaluate         |
| batch of actions        | agent-browser batch          |

- CDP on Brave: Brave is Chromium, so the same protocol works. agent-browser (installed, 0.39) is the client: `agent-browser --cdp 9222 …` with snapshot refs, fill, select, check, upload, click, batch.
- JEV: this machine already has TypeSafe Jev (the jev_evaluate tool and the typesafe-ai skill). We don't need it for speed yet: the main cost was screenshots and one tool call per click, not the model's choice. A JEV inner loop is an option for later (arc-cua's Chrome backend itself runs on Linux with TYPESAFE_API_KEY).

## Chosen approach

Angus's everyday Brave runs with DevTools on 127.0.0.1:9222 (two lines in ~/.config/brave-origin-flags.conf). Agents drive it with agent-browser over CDP: open their OWN new tab (`tab new`), read it with `snapshot -i -c`, do all the steps in one `batch`, read the result back, close their tab. Screenshots only to confirm something visual. hyprcu stays for things outside the page (native dialogs, other apps).

## Security trade-off

With the port open, any process on this laptop that can reach 127.0.0.1:9222 can fully control his logged-in Brave: read cookies and pages, run JavaScript in any tab, as him. That includes processes of other local users and sandboxed processes that have network access, because a TCP port on localhost has no owner check. It is not reachable from the network (it listens only on 127.0.0.1; checked with `ss -ltnp`). Mitigations, in order of strength:

- turn it on only while an agent drives (remove the flags lines; costs a Brave restart each time, so we didn't);
- a separate Brave profile just for agents (safer, but then he logs in there, which defeats "after his login");
- keep it as is but treat any unexpected local software as able to act as him in the browser.

Undo: delete the J669 lines in ~/.config/brave-origin-flags.conf (or restore brave-origin-flags.conf.bak-J669) and restart Brave.

## Benchmark (W2)

Same task both ways: open the local test form (bench/browser/index.html), fill name and email, pick a plan, tick the box, upload a file, submit, read the result.

| Path                        | Time      | Result  |
|-----------------------------|-----------|---------|
| hyprcu screenshot + clicks  | 66.5 s    | correct |
| CDP, throwaway Brave, 5 runs| 0.13-0.54 s | correct |
| CDP, his real Brave         | 0.66 s    | correct |

- hyprcu run (2026-10-15 20:18, throwaway Brave on workspace 99): 4 screenshots, 2 sequences, a GTK file chooser (one wrong path cost a retry), one click; timed from the start to the result read back. The wall time includes the model's turns, as it would for any agent.
- What the comparison measures: the hyprcu time is a whole agent workflow (the model's turns, screenshots, the file chooser and a retry); the CDP times are the scripted calls only (one snapshot, one batch), without the model's turn to decide them. So it isn't a controlled driver-against-driver test: it shows the workflow difference, one read and one batched call against a screenshot and a click per step. An agent's real CDP turn adds its own model time (seconds), still far below a minute.
- Checker FastCheck669 re-ran fast.sh on its own throwaway Brave: 0.27 / 0.36 / 0.20 / 0.31 / 0.25 s, all correct.
- CDP runs: bench/browser/fast.sh PORT 5; first run 0.54 s (cold), then 0.13-0.21 s. Upload goes straight into the file input (no file chooser).
- The real-Brave run opened its own tab and closed it; his 17 tabs were identical before and after (diff of /json/list).

# J670: JEV as the step picker (fast-browse)

Angus: "45 - i have a jev key but lets do b first … nm youve convinced me the jev key is in my basrc i think".

bin/fast-browse runs a page task like arc-cua's loop: read the page's interactive elements (agent-browser snapshot) → build the legal actions (fill a field with a given input, pick an option, tick, click, upload a given file, press Enter) → one JEV request with two questions in parallel (a choice: which action next, including DONE and BLOCKED; a noul: does the page meet the verification) → run the action → repeat. Below the confidence threshold, or when JEV says BLOCKED, it stops with exit 3 and the top candidates, so the calling agent takes that step. Literal text only comes from --input; password, PIN, MFA and card fields are never offered.

## Benchmark (W2)

Throwaway headless Brave, local pages (bench/browser: the upload form; shop/: list → product → cart → checkout → confirmation). Each result checked on the page itself (bench/browser/jev-bench.sh), 3 runs each.

| Task, method          | Time      | Steps   | Cost       |
|-----------------------|-----------|---------|------------|
| form, JEV picker      | 4.4-6.0 s | 7       | $0.00034   |
| form, agent-driven    | 10.3 s    | 2 turns | agent's    |
| shop, JEV picker      | 5.4-5.9 s | 9       | $0.00034   |
| shop, agent-driven    | 26.2 s    | 5 turns | agent's    |

- JEV picker: all 6 runs DONE and the page showed the exact expected result. About 0.5-0.9 s per step (snapshot + page text + one JEV call + the action); the first call of a run can be slower (one cold call took 9 s).
- Agent-driven: the plain fast path with the calling agent (Claude) deciding: snapshot, then a batch, per page; timed from the first command to the result, including the agent's own model turns. The agent already knew both tasks, so this is a best case for it. Its cost is its model's: each turn re-sends the agent's whole context (for this agent, on the order of 100k tokens, mostly cache reads), so cents per turn against hundredths of a cent for JEV.
- So the picker is about 2× faster on the one-page form and about 4.5× on the 4-page shop, and it takes no turns of the calling agent; the agent's batch is still the better choice for one page it already understands.
- Fallback checked: on checkout without an address input, JEV chose BLOCKED (0.58) and fast-browse stopped with NEEDS_AGENT and the candidates.
- Real Brave (read-only, his OK'd fast path): a new tab, "open the Wikipedia article about Kurt Gödel with the search box": 4 steps, 6.2 s, 49k tokens ≈ $0.002, DONE; tab closed, his 13 tabs identical before and after. Toast before, step toasts, done toast.
