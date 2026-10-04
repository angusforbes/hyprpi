// The document viewer (J56, Angus: "a way to read markdown on this webpage … it was hard to read
// because all in a MD file"). /file?path=X.md serves this page; it fetches the text with raw=1
// (the server's J47 guard decides, as for any file) and renders it with the app's own Markdown
// renderer (md.mjs). "raw" shows the source. Links inside open through /file (relative ones
// against the document's folder), [[wiki links]] through /wiki (the vault), https as they are.
import { esc, md, setBase } from "/md.mjs";

const $ = (s) => document.querySelector(s);
const docPath = new URLSearchParams(location.search).get("path") || "";
const HOME = "/home/agf";
let text = "", raw = false;

function show() {
  const el = $("#doc");
  el.className = raw ? "raw" : "md";
  el.innerHTML = raw ? esc(text) : md(text, { doc: true });
  $("#vraw").classList.toggle("on", raw);
  $("#vraw").textContent = raw ? "rendered" : "raw";
}
$("#vraw").addEventListener("click", () => { raw = !raw; show(); window.scrollTo(0, 0); });

// The colours follow the desktop theme, like the app.
fetch("/api/state", { cache: "no-store" }).then((r) => r.json()).then((s) => {
  for (const [k, v] of Object.entries(s.theme || {})) document.documentElement.style.setProperty("--" + k, v);
  if (s.theme?.bg) document.querySelector("meta[name=theme-color]").content = s.theme.bg;
}).catch(() => {});

(async () => {
  const name = docPath.split("/").pop() || "document";
  document.title = name.replace(/\.(md|markdown)$/i, "");
  $("#vname").textContent = document.title;
  $("#vdir").textContent = docPath.replace(/\/[^/]*$/, "").replace(HOME, "~");
  try {
    const r = await fetch(`/file?path=${encodeURIComponent(docPath)}&raw=1`, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status === 404 ? "not found, or not allowed" : r.statusText);
    text = await r.text();
    setBase(docPath.startsWith("~/") ? HOME + docPath.slice(1) : docPath);
    show();
  } catch (e) { $("#doc").innerHTML = `<p class="err">✗ ${esc(e.message)}</p>`; }
})();
