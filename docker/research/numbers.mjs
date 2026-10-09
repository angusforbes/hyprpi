// J352 (Angus: idea 5 from the J349 red team): numbers however they are written. The host's plan check used to compare
// only ASCII digit runs and let 19xx/20xx years through, so "five thousand three hundred twenty-two" came back as
// "RFC 5322", "MCMLVII" as 1957 and "seventeen twenty-nine" as 1729. Here every way of writing a number in a text is
// read into the digit strings it can stand for:
//   digits (1957, 1,957, 17 29 → 1729), English number words (standard: "one thousand nine hundred fifty-seven";
//   year-style pairs: "nineteen fifty-seven", "eighty-six oh one"; digit by digit: "one seven two nine"), and
//   Roman numerals (uppercase, at least 3 letters: MCMLVII).
// numbersIn(text) → Set of digit strings of 3 or more digits (no year exemption).
// numberLeaks(request, searchTexts, { allow }) → the numbers from the request that a search carries in any form
//   (equal, or one contains the other); `allow` = text whose numbers are fine (the host-set task).

const UNITS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { hundred: 100, thousand: 1000, million: 1e6 };
const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

export function romanValue(s) {
  if (!/^[MDCLXVI]{3,}$/.test(s)) return null; // 3+ letters: "DC", "CD", "XL" are usually acronyms
  let v = 0;
  for (let i = 0; i < s.length; i++) { const a = ROMAN[s[i]], b = ROMAN[s[i + 1]] || 0; v += a < b ? -a : a; }
  return v > 0 && toRoman(v) === s ? v : null; // canonical only ("IIII", "VX" aren't numbers)
}
function toRoman(n) {
  const t = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let o = ""; for (const [v, r] of t) while (n >= v) { o += r; n -= v; } return o;
}

// The text as tokens: {k: "word"|"digits"|"roman"|"sep"|"other", v, w}
function tokens(text) {
  const out = [];
  const re = /\d+(?:,\d{3})+(?!\d)|\d+|[A-Za-z]+|[-–—,]|\s+|./g;
  let m;
  while ((m = re.exec(String(text).normalize("NFKC")))) {
    const t = m[0];
    if (/^\s+$/.test(t)) continue;
    if (/^\d/.test(t)) out.push({ k: "digits", v: t.replace(/,/g, "") });
    else if (/^[A-Za-z]+$/.test(t)) {
      const w = t.toLowerCase(), r = romanValue(t);
      if (r != null) out.push({ k: "roman", v: String(r) });
      else if (w in UNITS || w in TEENS || w in TENS || w in SCALES) out.push({ k: "word", w });
      else if (w === "and" || w === "dash" || w === "hyphen" || w === "point") out.push({ k: "sep", w });
      else out.push({ k: "other" });
    } else if (/^[-–—,]$/.test(t)) out.push({ k: "sep", w: t });
    else out.push({ k: "other" });
  }
  return out;
}

// Standard English value of a run of number words ("one thousand nine hundred fifty seven" → 1957), or null.
function standard(ws) {
  let total = 0, cur = 0, any = false;
  for (const w of ws) {
    if (w in UNITS) { cur += UNITS[w]; any = true; }
    else if (w in TEENS) { cur += TEENS[w]; any = true; }
    else if (w in TENS) { cur += TENS[w]; any = true; }
    else if (w === "hundred") { cur = (cur || 1) * 100; any = true; }
    else if (w === "thousand" || w === "million") { total += (cur || 1) * SCALES[w]; cur = 0; any = true; }
  }
  return any ? total + cur : null;
}
// Small chunks (< 100) read in sequence and joined: "seventeen twenty nine" → "1729", "eighty six oh one" → "8601",
// "one seven two nine" → "1729". Two readings: tens+unit merged ("twenty nine" = 29) and not merged (20, 9).
function chunked(ws, merge) {
  if (ws.some((w) => w in SCALES)) return null;
  const parts = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (w === "oh" || w === "zero") { const n = ws[i + 1]; if (n in UNITS && n !== "oh" && n !== "zero") { parts.push("0" + UNITS[n]); i++; } else parts.push("0"); continue; }
    if (w in TEENS) { parts.push(String(TEENS[w])); continue; }
    if (w in TENS) { const n = ws[i + 1]; if (merge && n in UNITS && UNITS[n] > 0) { parts.push(String(TENS[w] + UNITS[n])); i++; } else parts.push(String(TENS[w])); continue; }
    if (w in UNITS) parts.push(String(UNITS[w]));
  }
  return parts.length ? parts.join("") : null;
}

export function numbersIn(text) {
  const out = new Set(), toks = tokens(text);
  const add = (s) => { if (s && /^\d{3,}$/.test(s)) out.add(s.replace(/^0+(?=\d{3})/, "")); };
  // runs of number-ish tokens (words, digits, roman numerals) joined by separators only
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const ws = run.filter((t) => t.k === "word").map((t) => t.w);
    const nums = run.filter((t) => t.k === "digits" || t.k === "roman").map((t) => t.v);
    for (const n of nums) add(n);
    if (ws.length && !nums.length) {
      const st = standard(ws); if (st != null) add(String(st));
      add(chunked(ws, true)); add(chunked(ws, false));
      // and every sub-run split at a scale-free boundary: "nineteen fifty seven and two thousand"
    }
    // a mixed or digit-only run is also read joined: "17 29" → 1729, "nineteen 57" → 1957
    if (run.length > 1) {
      const pieces = [];
      let wbuf = [];
      const wflush = () => { if (wbuf.length) { const c = chunked(wbuf, true) ?? (standard(wbuf) != null ? String(standard(wbuf)) : null); if (c != null) pieces.push(c); wbuf = []; } };
      for (const t of run) { if (t.k === "word") wbuf.push(t.w); else if (t.k === "digits" || t.k === "roman") { wflush(); pieces.push(t.v); } }
      wflush();
      if (pieces.length > 1) add(pieces.join(""));
    }
    run = [];
  };
  for (const t of toks) {
    if (t.k === "word" || t.k === "digits" || t.k === "roman") run.push(t);
    else if (t.k === "sep" && run.length) continue;
    else flush();
  }
  flush();
  return out;
}

// The numbers (3+ digits) from `request` that any of `texts` carries in any written form.
export function numberLeaks(request, texts, { allow = "" } = {}) {
  const req = numbersIn(request), ok = numbersIn(allow), hits = new Set();
  for (const r of req) {
    if (ok.has(r)) continue;
    for (const t of texts) for (const n of numbersIn(t)) if (n === r || n.includes(r) || r.includes(n)) hits.add(n);
  }
  return [...hits];
}
