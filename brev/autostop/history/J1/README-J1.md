# J1: Brev low-credit warnings (from the hub, 2026-10-13)

Angus: "b yes at $20", then "lets actually add warnings for $50, $20, $10, $5, $1, $0 ... all the way down to $0 so i feel increasing pressure to get more credits".

## State
- LIVE on the hub (`hub`, world I): `~/.local/share/brev-autostop/brev-autostop`; live config `~/.config/hyprpi/brev-autostop.conf` has `credit_warn_usd 50 20 10 5 1 0`.
- NOT yet in the laptop repo. The hub's `~/hyprpi` is a git-less synced copy, so the change travels as these patches.
  Until they're applied on the laptop, a `deploy-hub` (or a sync of ~/hyprpi to the hub) overwrites the script and drops the warnings silently.

## For the laptop (please do)
1. `cd ~/Harness/hyprpi && git switch -c job/J1`
2. `patch -p0`-style apply, or by hand: `patch brev/autostop/brev-autostop < J1-brev-autostop.patch` and
   `patch brev/autostop/brev-autostop.conf.example < J1-conf-example.patch`.
   Both are against the deployed hub version, which equals hyprpi 8e18d80's brev/autostop.
   Result sha256 of brev-autostop starts with the hash in PATCHED.sha256.
3. `bash -n brev/autostop/brev-autostop`, then commit on job/J1. It needs an independent check before master (J211).
4. Add `credit_warn_usd 50 20 10 5 1 0` to the laptop's own `~/.config/hyprpi/brev-autostop.conf` too, so configs agree.
   The laptop copy is the backup (BREV_AUTOSTOP_PRIMARY=hub) and never reads credit itself.

## What it does
- Every 3 h (hourly once under $20), the main copy reads GET `brevapi2…/api/organizations/ORG/billingprofile` with the brev CLI's login token (passed to curl on a file descriptor; never on a command line or in a log). It uses `credit_details.remaining_credits`, in cents. It does NOT use /credits, which says $0.
- One alert per level crossed, sharper each time: $50 normal; $20 and $10 "⚠ … top up soon"; $5 and $1 "🚨 almost gone … now"; $0 "🚨 GONE … NOW". All but $50 are critical (phone priority high). Each alert names the next level. If several levels are crossed between reads, one alert goes out, for the lowest.
- A level re-arms when credit is back at or above it (a top-up). It only warns: auto-stop never stops boxes for credit.
- A failed API read is logged once and sends no alert; the idle-stop runs regardless.
- `brev-autostop status` shows: "credit warnings at $50, $20, $10, $5, $1, $0: last read $NNN.NN at …".

## Tested (hub)
- Fake billing server, walking a high balance → 60 → 49.99 → 45 → 19.99 → 15 → 9.99 → 4.99 → 4.50 → 0.99 → 0 → -0.50 → -1 → 30 → 15 → 250 → 7. Each level fired exactly once on the way down. After the top-up to $30 it re-armed below $50 and $15 then fired the $20 level again (correct: the $30 top-up re-armed it). After $250 everything re-armed, and $7 fired the $10 level.
- Real API: reads the real balance; the timer run result is success. The training box's pause is unchanged, and idle-stop is unchanged.

## Undo
Remove the `credit_warn_usd` line from the hub's config (the code is then inert), or reverse-apply the patches.
