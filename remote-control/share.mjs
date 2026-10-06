// Sharing real files to the iOS share sheet (J173, Angus: "When I tried to share it, it shared the
// link, not the actual mp4 file"). Used by the file viewer (fileview.mjs) and the Files/Fils selection
// bar (files.js).
//
// Why it shared a link: the server sent an mp4 as text/plain, so the File handed to canShare() was a
// text file named .mp4, which iOS refuses; the code then fell back to sharing the URL. And anything
// over 60 MB was never fetched at all, so it went straight to the URL too.
//
// Now: the file is fetched as a blob ahead of the tap (iOS only opens the sheet inside the tap itself,
// so it can't wait for a download then), with progress; it becomes a File with the right MIME type from
// its extension; canShare({files}) decides; if iOS says no (type, size), it downloads instead and says
// so. iOS Web Share (Safari 15+ / Home Screen apps): images, video, audio, PDF and text files are
// accepted; there's no documented size limit, but the whole file is held in memory, so above MAX we
// download instead.
export const MAX = 250e6; // bytes held in memory to share; larger files download
const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml",
  mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", webm: "video/webm",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", zip: "application/zip",
};
export const mimeFor = (name) => MIME[String(name).toLowerCase().split(".").pop()] || "application/octet-stream";
export const fileUrl = (p) => "/file?path=" + encodeURIComponent(p);
export const mb = (n) => (n / 1e6).toFixed(n < 10e6 ? 1 : 0) + " MB";

// Fetch a blob with progress: onProgress(loaded, total). Resolves null when it's over MAX (not fetched).
export async function loadBlob(url, { onProgress = () => {}, max = MAX, signal } = {}) {
  const r = await fetch(url, { cache: "no-store", signal });
  if (!r.ok) throw new Error(r.status === 404 ? "not found, or not allowed" : r.statusText);
  const total = +r.headers.get("content-length") || 0;
  if (total > max) { r.body?.cancel?.(); return null; }
  if (!r.body?.getReader) { const b = await r.blob(); onProgress(b.size, b.size); return b; }
  const rd = r.body.getReader(), parts = []; let got = 0;
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    parts.push(value); got += value.length; onProgress(got, total);
    if (got > max) { rd.cancel(); return null; }
  }
  return new Blob(parts, { type: r.headers.get("content-type") || "" });
}

// Share Files through the sheet. → "shared" | "cancelled" | "refused" (canShare said no) | "none" (no sheet).
export async function shareFiles(files, title) {
  if (!navigator.share) return "none";
  if (!navigator.canShare?.({ files })) return "refused";
  try { await navigator.share({ files, ...(title ? { title } : {}) }); return "shared"; }
  catch (e) { if (e.name === "AbortError") return "cancelled"; throw e; }
}
export const asFile = (blob, name) => new File([blob], name, { type: mimeFor(name) });

// The fallback: a real download (the server sends Content-Disposition: attachment for dl=1).
export function download(path, name) {
  const a = document.createElement("a"); a.href = fileUrl(path) + "&dl=1"; a.download = name || ""; document.body.append(a); a.click(); a.remove();
}
