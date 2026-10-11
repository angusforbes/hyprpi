// J458 (Angus: "same logic for both … they are both controlled by the gate"; "2 is fine, they are already polling anyway"): both
// drop-box folders are read the same way, plain polling at this interval, no fs.watch. The host relay polls every sandbox's outbox
// (docker/sbx-relay.mjs); G's Doorman-G mailbox polls G's inbox (docker/world/doorman-notify.mjs, J464; was the gate g-gate.mjs), run inside G from the host checkout, read-only.
export const DROPBOX_POLL_MS = 1000;
