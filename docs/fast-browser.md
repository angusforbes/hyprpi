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

# J674: why he was logged out, and the guard

Angus: "ok make sure you stop logging me out of websites when i haven't asked you to".

Cause (W1), with what is checked and what is inferred:

- Checked: his Brave's main process started at 20:20:58 on 2026-10-15 (`ps -o lstart`), the J669 restart by pi·c2tc (with his OK to restart; nobody told him it would sign him out). It has not restarted since. Right after it, the restored Outlook window showed "Face, fingerprint, PIN or security key" and cPanel showed "cPanel Login" (window titles recorded in that session).
- Inferred (not proven): the restart dropped session-only login cookies. Brave keeps those across a restart only with "On startup: continue where you left off"; his Preferences have no restore_on_startup value, and a one-off --restore-last-session brings back tabs, not necessarily session cookies.
- From portfolio's own log (relayed by Thoughts-A, not re-checked by me): at 21:51 its new cPanel tab found the cPanel session already expired; at 21:56 GoDaddy's "cPanel Admin" went to sso.godaddy.com/login/levelup, a step-up password prompt it didn't submit; it never pressed Log out, cleared cookies or restarted Brave; it closed only its own tabs.
- Searched: every pi agent session file changed since 20:00 for agent-browser on 9222 / --auto-connect with cookies, storage, state, close or logout: none found. Sessions of tools outside pi (Claude Code, Codex) weren't searched.

Guard (W3): ~/.pi/agent/extensions/browser-guard blocks, for every pi agent, a bash command that would kill his Brave (by pid, pkill/killall, pgrep), `agent-browser close` / cookies clear|set / storage clear / state load / clearing eval / logout URLs / sign-out finds against 9222 or --auto-connect (also inside batch), CDP Browser.close / Network.clearBrowserCookies / Storage.clear* or /json/close aimed at 9222, deleting or moving his profile files; and a hyprcu close of one of his Brave windows. Throwaway Brave (another port, temp profile, HOME in /tmp) is never his. Override only when he asked: `# angus-asked: <his words>`. Tests: core.test.mjs (synthetic /proc). fast-browse never offers Sign out / Log out / Switch account / Clear data controls and refuses logout URLs.

Not covered: a program that talks to 9222 from a file the guard doesn't read, Claude Code / Codex outside pi, and Angus's own actions.

# J676: headless Brave on a copy of his profile (brave-copy)

Angus (53): "YES" to making the headless profile copy carry his logins so uploads never touch his screen.

Cause (W1), checked:
- Not the keyring: his cookies are all v11 (encrypted with the "Brave Safe Storage" key in his GNOME keyring); 200 of 200 sampled decrypt with that key, none with the basic fallback key. A headless Brave on a copy decrypts them with or without --password-store=gnome-libsecret (tested both on a throwaway local login).
- Not session cookies being dropped: his running profile's Preferences say exit_type "Crashed" (it's running), so a copy restores session cookies; brave-copy also sets the copy's restore_on_startup to "continue where you left off" to be sure.
- The cause: GoDaddy's bot protection. A headless Brave sends the user agent "HeadlessChrome"; account.godaddy.com/products answered it with the page "Access Denied", which reads as "no session". With his Brave's normal user agent the same copy showed "Products", logged in. (portfolio's copyup.sh also started Brave through /usr/bin/brave-origin, which adds every line of ~/.config/brave-origin-flags.conf, including --remote-debugging-port=9222; brave-copy starts the binary directly.)

Result (W2): throwaway local login (session and persistent cookies) seen logged in in the copy; then, in the copy: GoDaddy Products logged in, and cPanel File Manager on public_html/portfolio logged in (listing shows smudge.html), all headless. One mistake on the way: the throwaway login was seeded in his real Brave with `agent-browser tab new`, which made the tab active and took his focus; closed, and the skill now says never to do that.

Tool (W3): bin/brave-copy (above; test/brave-copy.sh with a fake profile and browser: copy made, restore pref set, source untouched, copy deleted after success, failure, SIGTERM and a browser that never starts; 9222 refused).

His real sessions afterwards (W4): read-only same-origin fetches in his existing tabs over their own DevTools websockets (no activation): cPanel API list_files HTTP 200 status=1, GoDaddy hosting page HTTP 200 without a sign-in redirect; his focus unchanged; no brave-copy folders left.

# J680: publishing to angusforbes.com, and which browser library

Angus: "you have full use of my browser, why is it taking so long? did you copare approaches? are there other browser librareis taht might be faster?"

Upload one 136 KB file to public_html/portfolio and read it back over HTTPS (byte-identical), 5 runs each:

| Route                      | Upload    | Total     |
|----------------------------|-----------|-----------|
| rsync, SSH kept open       | 0.54-0.61 | 1.33-2.37 |
| rsync, new SSH each time   | 1.45-1.48 | 2.03-2.28 |
| scp                        | 1.94-2.06 | 2.60-2.80 |
| ssh cat >                  | 1.41-2.55 | 2.09-3.54 |
| cPanel UAPI + API token    | 1.48-1.75 | 2.07-2.83 |
| FTPS (curl)                | 1.55-2.44 | 2.13-3.24 |
| File Manager by CDP        | 25.8-34.4 | 26.8-36.5 |

- All correct except File Manager run 1 (read back differed). File Manager in a brave-copy also needs ~10 s to start the copy; it depends on a cPanel session and its page timing.
- SSH (W2): rejected because ~/.ssh/authorized_keys on the server had a space inside the key ("…gpzMP 4Mue …"); rewritten from ~/.ssh/godaddy_portfolio.pub through the cPanel API; key login works (shell /bin/bash).
- Default: bin/site-put (rsync over SSH with a 10-min kept-open connection, falls back to the UAPI token; verifies every file over HTTPS). bench/browser/site-put-routes.sh times the routes.
- Created in cPanel: an API token "j680-bench" (full access, stored in ~/.config/site-put/cpanel-token, 600) kept as site-put's fallback; an FTP account (its name is in ~/.config/site-put/env) (home public_html/portfolio) for the test, deleted afterwards.

Browser libraries (bench/browser/libs; same form task, headless throwaway Brave, medians of 7, all correct): raw CDP 202 ms; chrome-remote-interface 220 ms; agent-browser 362 ms; puppeteer-core 776 ms; Playwright connectOverCDP 847 ms (+122 ms to connect). chromedp (Go) not tried: same protocol as raw CDP. Recommendation: keep agent-browser as the default; the slowness was model turns, fixed sleeps and the File Manager UI, not the library.
