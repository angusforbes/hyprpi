// Demo harness for pi-extension/quiet.ts (J637): the same quiet mode and the same incoming-message rendering as
// hyprpi's index.ts, without connecting to a hyprpi daemon. `PI_QUIET_TOOLS=1 pi -e quiet-demo.ts --session fixture3.jsonl`
import { Box, Text } from "@earendil-works/pi-tui";
import { quietMode, quietIncoming, quietOrch } from "../../pi-extension/quiet.ts";
export default function (pi: any) {
  const quiet = quietMode(pi);
  const render = (message: any, { outputPad, expanded }: any, theme: any) => {
    if (quiet) { const q = quietIncoming(message, !!expanded, theme); if (q) return q; }
    const box = new Box(outputPad, 1, (t: string) => theme.bg("userMessageBg", t));
    box.addChild(new Text(theme.fg("userMessageText", String(message.content ?? "")), 0, 0));
    return box;
  };
  pi.registerMessageRenderer("hyprpi-talk", render);
  pi.registerMessageRenderer("hyprpi-talk-reply", render);
  if (quiet) pi.registerMessageRenderer("hyprpi-orch", (m: any, o: any, theme: any) => quietOrch(m, !!o?.expanded, theme) ?? undefined);
}
