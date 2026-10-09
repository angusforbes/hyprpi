-- hyprpi voice-routing — Hyprland (Omarchy Lua config) key bindings.
-- Copy into ~/.config/hypr/bindings.lua and adjust the keys.
--
-- The reference setup uses Caps Lock remapped to F9 by keyd (Omarchy's stock
-- dictation key), so SUPER + Caps Lock arrives as SUPER + F9.
--   NOTE: if keyd has a [shift] layer mapping capslock back to capslock, any
--   chord that includes Shift will never produce F9 — use ALT, not SHIFT.
--
-- Push-to-talk: first press records, second press transcribes and delivers
-- to the selected agent(s)/room(s). In hands-free mode the same key mirrors
-- the spoken start/stop phrases.
o.bind("SUPER + F9", "Voice to agent (toggle)", "voice-agent")

-- Target picker / hands-free switch. Omarchy: open the bar widget. Elsewhere:
-- use the pop-up picker instead.
o.bind("SUPER + ALT + F9", "Voice panel (targets / hands-free)", "omarchy-shell herdr.voice toggle")
-- o.bind("SUPER + ALT + F9", "Voice target picker", "voice-agent target")

-- Optional: the classic pop-up picker on SUPER + CTRL + ALT + Caps Lock. keyd composite layers emit F13
-- for that chord and strip their own modifiers, and xkb names keycode F13 XF86Tools (see README.md,
-- "Extra Caps Lock chords").
-- o.bind("SUPER + XF86Tools", "Voice agent target picker", "voice-agent target")
