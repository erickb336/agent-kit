// Draws the README's graphics as SVG, each in a light and a dark version (docs/assets/<name>-light.svg, -dark.svg).
// The README shows the version that matches the reader's GitHub theme. Run `npm run graphics` after a change here.
// The hero and "How it works" show a misty mountain world (see "The misty mountain world" below). The look is
// inspired by Sage Mode in Naruto (orange markings, a toad-like eye, natural energy) with original shapes only:
// no characters, logos, clothing patterns or village symbols. The mascot is an original toad sage.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../docs/assets");

export const THEMES = {
  light: { bg: "#FBF7F1", panel: "#FFFFFF", ink: "#1C1410", muted: "#6E5F53", faint: "#A3927F", line: "#EADFCF", accent: "#E5600B", gold: "#E9A91B", soft: "#FDEBD9", chip: "#F6EFE6", chief: "#21160F", chiefInk: "#FFF4E8", ok: "#2F8552", bad: "#C2412D", energy: "#F0A050", white: "#FFF9F1", toad: "#A0693F", toadShade: "#7E5130", toadBelly: "#F3D6AC", toadLine: "#3B2414", blush: "#F0907E" },
  dark: { bg: "#100B08", panel: "#1A130F", ink: "#F6EEE6", muted: "#BCAA98", faint: "#7F6F62", line: "#3A2B21", accent: "#FF7A1F", gold: "#F6C343", soft: "#2A190D", chip: "#1E1611", chief: "#FF7A1F", chiefInk: "#140D08", ok: "#6CC28F", bad: "#F08A78", energy: "#FF8C3A", white: "#FFF6EA", toad: "#B47D50", toadShade: "#8A5A36", toadBelly: "#F0D2A6", toadLine: "#24150B", blush: "#F0907E" },
};
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attrs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}="${v}"`).join(" ");

/** Text, one tspan per line. */
function text(x, y, lines, { size = 16, weight = 400, fill, anchor = "start", mono = false, lh = 1.35, opacity, ls } = {}) {
  const ts = [].concat(lines).map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : size * lh}">${esc(l)}</tspan>`).join("");
  return `<text ${attrs({ x, y, "font-family": mono ? MONO : SANS, "font-size": size, "font-weight": weight, fill, "text-anchor": anchor, opacity, "letter-spacing": ls })}>${ts}</text>`;
}
const rect = (x, y, w, h, o = {}) => `<rect ${attrs({ x, y, width: w, height: h, rx: o.rx ?? 12, fill: o.fill ?? "none", stroke: o.stroke, "stroke-width": o.sw, "stroke-dasharray": o.dash, opacity: o.opacity })}/>`;
const path = (d, o = {}) => `<path ${attrs({ d, fill: o.fill ?? "none", stroke: o.stroke, "stroke-width": o.sw ?? 2, "stroke-dasharray": o.dash, "marker-end": o.arrow ? `url(#${o.arrow === true ? "arrow" : o.arrow})` : undefined, "stroke-linecap": "round", opacity: o.opacity })}/>`;
const circle = (cx, cy, r, o = {}) => `<circle ${attrs({ cx, cy, r, fill: o.fill ?? "none", stroke: o.stroke, "stroke-width": o.sw, opacity: o.opacity })}/>`;
const arrowTo = (x1, y1, x2, y2, t, o = {}) => path(`M${x1} ${y1} L ${x2} ${y2}`, { stroke: o.stroke ?? t.muted, sw: o.sw ?? 2, arrow: o.arrow ?? true, dash: o.dash });

/** The sage eye, the project's mark: orange markings, a gold iris and a horizontal, toad-like pupil. */
function eye(cx, cy, w, t) {
  const h = w * 0.5;
  const almond = (ww, hh, dy = 0) => `M${cx - ww / 2} ${cy + dy} Q ${cx} ${cy + dy - hh}, ${cx + ww / 2} ${cy + dy} Q ${cx} ${cy + dy + hh}, ${cx - ww / 2} ${cy + dy} Z`;
  const r = h * 0.43;
  return [
    path(almond(w * 1.34, h * 1.55, -h * 0.08), { fill: t.accent, sw: 0 }),
    path(almond(w, h), { fill: t.white, sw: 0 }),
    circle(cx, cy, r, { fill: t.gold, stroke: "#8A5A06", sw: w * 0.02 }),
    rect(cx - r * 0.78, cy - r * 0.2, r * 1.56, r * 0.4, { rx: r * 0.2, fill: "#140B06" }),
    circle(cx - r * 0.38, cy - r * 0.45, r * 0.16, { fill: "#FFFFFF", opacity: 0.85 }),
  ].join("");
}

/** A faint spiral of natural energy behind a graphic. */
function energy(cx, cy, turns, step, t, opacity = 0.16) {
  const pts = [];
  for (let a = 0; a <= turns * 2 * Math.PI; a += 0.08) {
    const r = 18 + step * a;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return path(`M${pts.join(" L ")}`, { stroke: t.energy, sw: 2, opacity });
}

let toadCount = 0;
const ellipse = (cx, cy, rx, ry, o = {}) => `<ellipse ${attrs({ cx, cy, rx, ry, fill: o.fill ?? "none", stroke: o.stroke, "stroke-width": o.sw, opacity: o.opacity })}/>`;

/** The toad sage, the mascot: an original round toad with orange sage markings, gold toad eyes and a ✓ headband. */
function toad(cx, cy, s, t, { wave = false } = {}) {
  const u = (x) => +(cx + x * s).toFixed(1), v = (y) => +(cy + y * s).toFixed(1), r = (n) => +(n * s).toFixed(2);
  const id = `toad-body-${++toadCount}`;
  const ink = { stroke: t.toadLine, sw: r(0.035) };
  const eyeAt = (x) => [
    ellipse(u(x), v(-0.5), r(0.28), r(0.26), { fill: t.accent }),
    circle(u(x), v(-0.5), r(0.2), { fill: t.white, stroke: t.toadLine, sw: r(0.02) }),
    circle(u(x), v(-0.5), r(0.15), { fill: t.gold }),
    rect(u(x - 0.1), v(-0.53), r(0.2), r(0.06), { rx: r(0.03), fill: "#140B06" }),
    circle(u(x - 0.05), v(-0.57), r(0.035), { fill: "#FFFFFF" }),
  ].join("");
  const arm = wave
    ? path(`M${u(0.8)} ${v(0.18)} Q ${u(1.08)} ${v(0.05)} ${u(1.12)} ${v(-0.28)}`, { stroke: t.toadLine, sw: r(0.2) }) +
      path(`M${u(0.8)} ${v(0.18)} Q ${u(1.08)} ${v(0.05)} ${u(1.12)} ${v(-0.28)}`, { stroke: t.toad, sw: r(0.13) }) +
      circle(u(1.12), v(-0.32), r(0.1), { fill: t.toad, ...ink })
    : ellipse(u(0.36), v(0.84), r(0.2), r(0.09), { fill: t.toadShade, ...ink });
  return [
    `<defs><clipPath id="${id}"><ellipse cx="${cx}" cy="${v(0.12)}" rx="${r(0.95)}" ry="${r(0.74)}"/></clipPath></defs>`,
    ellipse(u(-0.8), v(0.5), r(0.36), r(0.25), { fill: t.toadShade, ...ink }),
    ellipse(u(0.8), v(0.5), r(0.36), r(0.25), { fill: t.toadShade, ...ink }),
    circle(u(-0.44), v(-0.48), r(0.3), { fill: t.toad, ...ink }),
    circle(u(0.44), v(-0.48), r(0.3), { fill: t.toad, ...ink }),
    ellipse(cx, v(0.12), r(0.95), r(0.74), { fill: t.toad, ...ink }),
    ellipse(cx, v(0.42), r(0.58), r(0.34), { fill: t.toadBelly }),
    `<g clip-path="url(#${id})">${rect(u(-1), v(-0.3), r(2), r(0.15), { rx: 0, fill: "#2A1B12" })}</g>`,
    path(`M${u(0.74)} ${v(-0.26)} q ${r(0.22)} ${r(0.02)} ${r(0.3)} ${r(0.2)}`, { stroke: "#2A1B12", sw: r(0.06) }),
    path(`M${u(0.74)} ${v(-0.23)} q ${r(0.14)} ${r(0.12)} ${r(0.14)} ${r(0.3)}`, { stroke: "#2A1B12", sw: r(0.06) }),
    rect(u(-0.2), v(-0.34), r(0.4), r(0.22), { rx: r(0.05), fill: "#CBD2DA", stroke: "#7D8794", sw: r(0.02) }),
    path(`M${u(-0.09)} ${v(-0.23)} L ${u(-0.02)} ${v(-0.16)} L ${u(0.1)} ${v(-0.29)}`, { stroke: "#2A1B12", sw: r(0.045) }),
    eyeAt(-0.44),
    eyeAt(0.44),
    circle(u(-0.62), v(0.06), r(0.09), { fill: t.blush, opacity: 0.55 }),
    circle(u(0.62), v(0.06), r(0.09), { fill: t.blush, opacity: 0.55 }),
    path(`M${u(-0.46)} ${v(0.04)} Q ${cx} ${v(0.3)} ${u(0.46)} ${v(0.04)}`, { stroke: t.toadLine, sw: r(0.045) }),
    ellipse(u(-0.36), v(0.84), r(0.2), r(0.09), { fill: t.toadShade, ...ink }),
    arm,
  ].join("");
}

/** A speech bubble with a tail that points at (tx, ty). */
function say(x, y, w, h, tx, ty, lines, t, o = {}) {
  const midY = y + h / 2;
  const fromLeft = tx < x;
  const base = fromLeft ? x + 1 : x + w - 1;
  return (
    path(`M${base} ${midY - 10} L ${tx} ${ty} L ${base} ${midY + 10} Z`, { fill: t.panel, stroke: t.accent, sw: 2 }) +
    rect(x, y, w, h, { rx: 18, fill: t.panel, stroke: t.accent, sw: 2 }) +
    rect(fromLeft ? x + 2 : x + w - 4, midY - 9, 3, 18, { rx: 0, fill: t.panel }) +
    text(x + (o.center ? w / 2 : 22), y + (o.size ?? 19) + (h - [].concat(lines).length * (o.size ?? 19) * 1.4) / 2 - 2, lines, { size: o.size ?? 19, weight: o.weight ?? 600, fill: t.ink, anchor: o.center ? "middle" : "start", lh: 1.4 })
  );
}

/** A tip from the toad sage: the toad on the left, a speech bubble on the right. */
const tip = (lines, label) => (t) => svg(1000, 170, t, [energy(95, 92, 1.6, 9, t, 0.12), toad(95, 92, 56, t), say(196, 32, 776, 104, 166, 92, lines, t)].join("\n"), label);

function svg(w, h, t, body, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">
<defs>
<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${t.muted}"/></marker>
<marker id="arrow-accent" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${t.accent}"/></marker>
<marker id="arrow-bad" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${t.bad}"/></marker>
</defs>
<rect width="${w}" height="${h}" fill="${t.bg}"/>
${body}
</svg>
`;
}

/** A role box: writers get the orange border, read-only roles a plain one. */
const role = (x, y, w, h, name, writes, t, sub) =>
  rect(x, y, w, h, { rx: 12, fill: writes ? t.soft : t.panel, stroke: writes ? t.accent : t.line, sw: writes ? 2 : 1.5 }) +
  text(x + w / 2, y + (sub ? h / 2 - 2 : h / 2 + 6), name, { size: 16, weight: 650, fill: t.ink, anchor: "middle" }) +
  (sub ? text(x + w / 2, y + h / 2 + 18, sub, { size: 12.5, fill: t.muted, anchor: "middle" }) : "");

/* The misty mountain world of the hero and "How it works". An original drawing in the user's reference mood: a hooded
 * toad sage meditates at the centre, the team is a ring of glowing medallions on an arrowed loop, and behind them are
 * misty peaks, pagodas, waterfalls, a big moon and hanging scrolls, in charcoal and ember orange.
 * Grafted from the arena: the glaring toad eye and the burning wordmark (candidate 1), the 仙 strokes (candidate 3).
 * Every shape is in canvas coordinates (no transforms), so that the text checks test the right points. */
const f1 = (n) => +(+n).toFixed(1);
/** A seeded random generator, so that each run draws the same file. */
const seeded = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
/** Maps a path in local units (absolute M, L, Q, C and Z only) onto the canvas: x → ox + x·s·flip, y → oy + y·s. */
const tp = (d, ox, oy, s, flip = 1) => { let i = 0; return d.replace(/-?\d*\.?\d+/g, (n) => String(f1(i++ % 2 === 0 ? ox + +n * s * flip : oy + +n * s))); };
const EMBER = { orange: "#FF6A0F", hot: "#FF8A2A", gold: "#FFC93C", pale: "#F4E6CC", deep: "#C2410C", void: "#050302", ink: "#FFF3E4", muted: "#D6C0A8", wood: "#C9A27A" };
const pulseCss = `<style>.pulse{animation:pulse 5s ease-in-out infinite}@keyframes pulse{50%{opacity:.55}}@media (prefers-reduced-motion:reduce){.pulse{animation:none}}</style>`;

/** The gradients and filters of the world. id prefixes them, so that two graphics on one page never share an id. */
function worldDefs(id) {
  const markStops = `<stop offset="0" stop-color="#B83A0A"/><stop offset="0.55" stop-color="${EMBER.orange}"/><stop offset="1" stop-color="#FFB050"/>`;
  return `<linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#080605"/><stop offset="0.45" stop-color="#1B120C"/><stop offset="0.72" stop-color="#22160E"/><stop offset="1" stop-color="#0A0706"/></linearGradient>
<radialGradient id="${id}-haze"><stop offset="0" stop-color="${EMBER.hot}" stop-opacity="0.6"/><stop offset="0.5" stop-color="${EMBER.orange}" stop-opacity="0.2"/><stop offset="1" stop-color="${EMBER.orange}" stop-opacity="0"/></radialGradient>
<radialGradient id="${id}-moonglow"><stop offset="0.55" stop-color="#F2CD96" stop-opacity="0.5"/><stop offset="1" stop-color="#F2CD96" stop-opacity="0"/></radialGradient>
<radialGradient id="${id}-moon" cx="0.4" cy="0.36" r="0.72"><stop offset="0" stop-color="#F8E7C6"/><stop offset="0.6" stop-color="#E4BC88"/><stop offset="1" stop-color="#B8844F"/></radialGradient>
<radialGradient id="${id}-iris" cx="0.51" cy="0.52" r="0.56"><stop offset="0" stop-color="#FFF4C2"/><stop offset="0.16" stop-color="#FFD54A"/><stop offset="0.4" stop-color="#FDB022"/><stop offset="0.66" stop-color="#EE7A0C"/><stop offset="0.86" stop-color="#A83E08"/><stop offset="1" stop-color="#4A1803"/></radialGradient>
<linearGradient id="${id}-lid" x1="0" y1="0.34" x2="0" y2="0.96"><stop offset="0" stop-color="#000" stop-opacity="0.85"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
<linearGradient id="${id}-markR" x1="0" y1="0.5" x2="1" y2="0.3">${markStops}</linearGradient>
<linearGradient id="${id}-markL" x1="1" y1="0.5" x2="0" y2="0.3">${markStops}</linearGradient>
<linearGradient id="${id}-skin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#040202"/><stop offset="0.32" stop-color="#1A110B"/><stop offset="0.6" stop-color="#33231A"/><stop offset="0.86" stop-color="#2C1E14"/><stop offset="1" stop-color="#3A2618"/></linearGradient>
<linearGradient id="${id}-robe" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B2018"/><stop offset="1" stop-color="#100B08"/></linearGradient>
<linearGradient id="${id}-bust" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B2018"/><stop offset="1" stop-color="#0A0604"/></linearGradient>
<linearGradient id="${id}-hood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#382A1F"/><stop offset="1" stop-color="#18120D"/></linearGradient>
<linearGradient id="${id}-rock" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#33271D"/><stop offset="1" stop-color="#0D0907"/></linearGradient>
<radialGradient id="${id}-disc" cx="0.5" cy="0.42" r="0.62"><stop offset="0" stop-color="#3B2B1E"/><stop offset="1" stop-color="#100B08"/></radialGradient>
<radialGradient id="${id}-orb" cx="0.4" cy="0.38" r="0.65"><stop offset="0" stop-color="#FFF6D0"/><stop offset="0.45" stop-color="${EMBER.gold}"/><stop offset="1" stop-color="${EMBER.orange}"/></radialGradient>
<linearGradient id="${id}-fall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${EMBER.pale}" stop-opacity="0.95"/><stop offset="1" stop-color="${EMBER.pale}" stop-opacity="0"/></linearGradient>
<linearGradient id="${id}-word" x1="0" y1="0" x2="0" y2="1"><stop offset="0.2" stop-color="#FFF8EC"/><stop offset="0.5" stop-color="#FFD27A"/><stop offset="0.72" stop-color="${EMBER.hot}"/><stop offset="0.9" stop-color="#E2470A"/></linearGradient>
<linearGradient id="${id}-chief" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFA040"/><stop offset="1" stop-color="#F05A0A"/></linearGradient>
<filter id="${id}-wordglow" x="-10%" y="-20%" width="120%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="10" result="b"/><feFlood flood-color="${EMBER.orange}" flood-opacity="0.7"/><feComposite in2="b" operator="in" result="g"/><feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceGraphic" stdDeviation="2.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="${id}-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>
<filter id="${id}-mist" x="-30%" y="-200%" width="160%" height="500%"><feGaussianBlur stdDeviation="20"/></filter>`;
}

/** Karst peaks: a row of steep pillars with round tops, from base up by hMin..hMax, filled down to the bottom H. */
function ridge(r, W, H, base, hMin, hMax, wMin, wMax) {
  let x = -60, y = base, d = `M-60 ${H} L-60 ${base}`;
  const tops = [];
  while (x < W + 60) {
    const w = wMin + r() * (wMax - wMin), top = base - hMin - r() * (hMax - hMin), y1 = base - r() * 40;
    d += ` C${f1(x + w * 0.2)} ${f1(y - (y - top) * 0.55)} ${f1(x + w * 0.25)} ${f1(top)} ${f1(x + w * 0.5)} ${f1(top)}`;
    d += ` C${f1(x + w * 0.75)} ${f1(top)} ${f1(x + w * 0.8)} ${f1(y1 - (y1 - top) * 0.55)} ${f1(x + w)} ${f1(y1)}`;
    tops.push([f1(x + w * 0.5), f1(top)]);
    x += w;
    y = y1;
  }
  return { d: d + ` L${f1(x)} ${H} Z`, tops };
}

/** A small pine on a peak: three stacked, flattened crowns. */
const pine = (x, y, s, fill, op) => [[0, -14, 9, 3.2], [0, -8, 12, 3.6], [0, -2, 15, 4]].map(([dx, dy, rx, ry]) => ellipse(f1(x + dx * s), f1(y + dy * s), f1(rx * s), f1(ry * s), { fill, opacity: op })).join("") + path(`M${x} ${y} L ${x} ${f1(y + 8 * s)}`, { stroke: fill, sw: f1(2 * s), opacity: op });

/** A pagoda silhouette with three tiers of upturned eaves and lit windows. (x, base) is the middle of its foot. */
function pagoda(x, base, s, fill, op, id) {
  const P = (d) => tp(d, x, base, s);
  const parts = [`<path d="${P("M-30 0 L30 0 L26 -6 L-26 -6 Z")}" fill="${fill}" opacity="${op}"/>`];
  [[-6, 34, 20], [-30, 28, 15], [-52, 22, 11]].forEach(([y0, rw, bw]) => {
    parts.push(`<path d="${P(`M${-bw} ${y0} L${bw} ${y0} L${bw} ${y0 - 14} L${-bw} ${y0 - 14} Z`)}" fill="${fill}" opacity="${op}"/>`);
    parts.push(`<path d="${P(`M${-rw} ${y0 - 18} Q${-rw * 0.55} ${y0 - 15} ${-rw * 0.32} ${y0 - 21} L0 ${y0 - 27} L${rw * 0.32} ${y0 - 21} Q${rw * 0.55} ${y0 - 15} ${rw} ${y0 - 18} Q${rw * 0.5} ${y0 - 11} 0 ${y0 - 12} Q${-rw * 0.5} ${y0 - 11} ${-rw} ${y0 - 18} Z`)}" fill="${fill}" opacity="${op}"/>`);
    parts.push(`<path d="${P(`M-4 ${y0 - 3} L4 ${y0 - 3} L4 ${y0 - 10} L-4 ${y0 - 10} Z`)}" fill="${EMBER.hot}" opacity="0.48" filter="url(#${id}-glow)"/>`);
  });
  parts.push(path(P("M0 -79 L0 -94"), { stroke: fill, sw: f1(2.4 * s), opacity: op }));
  return parts.join("");
}

/** A thin waterfall from (x, y0) to y1, with its spray. */
const waterfall = (x, y0, y1, w, id) =>
  rect(x - w / 2, y0, w, y1 - y0, { rx: w / 2, fill: `url(#${id}-fall)`, opacity: 0.42 }) +
  path(`M${x - w / 4} ${y0 + 4} L ${x - w / 4} ${y1 - 30} M${x + w / 5} ${y0 + 10} L ${x + w / 5} ${y1 - 50}`, { stroke: "#FFFFFF", sw: 1, opacity: 0.25 }) +
  `<ellipse cx="${x}" cy="${y1}" rx="${w * 3.5}" ry="${w * 1.2}" fill="${EMBER.pale}" opacity="0.16" filter="url(#${id}-mist)"/>`;

/** A band of mist: soft, wide ellipses. */
const mist = (y, id, r, op = 0.12, W = 1280) => Array.from({ length: 5 }, (_, i) => `<ellipse cx="${f1((i + r() * 0.6) * (W / 4.4))}" cy="${f1(y + (r() - 0.5) * 30)}" rx="${f1(160 + r() * 140)}" ry="${f1(18 + r() * 16)}" fill="#E9D6BC" opacity="${f1(op * (0.6 + r() * 0.6))}" filter="url(#${id}-mist)"/>`).join("");

/** Embers of natural energy: faint gold and orange dots between y0 and y1. */
const embers = (r, n, W, y0, y1) => Array.from({ length: n }, () => circle(f1(20 + r() * (W - 40)), f1(y0 + r() * (y1 - y0)), f1(0.8 + r() * 2.2), { fill: r() > 0.45 ? EMBER.gold : EMBER.hot, opacity: f1(0.18 + r() * 0.3) })).join("");

/** The kanji 仙 ("sage") as strokes in a 100-unit box (after candidate 3's seal), centred on (cx, cy). */
const XIAN = ["M35 22 C32 31 27 40 20 49", "M28 40 L28 79", "M61 21 L61 79", "M44 42 L44 79", "M78 42 L78 79", "M43 79 L79 79"];
const xian = (cx, cy, size, color) => path(XIAN.map((d) => tp(d, cx - size / 2, cy - size / 2, size / 100)).join(" "), { stroke: color, sw: f1(size * 0.085) });

/** A tall hanging scroll: a cord, two rods, a dark paper with abstract brush marks, and an optional 仙 and seal. */
function banner(x, y, w, h, r, glyph) {
  const c = x + w / 2;
  const marks = [];
  for (let my = y + (glyph ? 120 : 60); my < y + h - 110; my += 46 + r() * 30) {
    const dx = (r() - 0.5) * 14, len = 22 + r() * 26;
    marks.push(path(`M${f1(c - 10 + dx)} ${f1(my)} C${f1(c - 2 + dx)} ${f1(my + len * 0.3)} ${f1(c + 6 + dx)} ${f1(my + len * 0.6)} ${f1(c + 12 + dx)} ${f1(my + len)}`, { stroke: r() > 0.7 ? EMBER.deep : "#8C7058", sw: f1(2.5 + r() * 3.5), opacity: 0.75 }));
    if (r() > 0.5) marks.push(path(`M${f1(c - 14)} ${f1(my + len + 10)} L ${f1(c + 12)} ${f1(my + len + 6)}`, { stroke: "#8C7058", sw: 2.4, opacity: 0.6 }));
  }
  return [
    path(`M${x + 8} ${y - 4} L ${c} ${y - 40} L ${x + w - 8} ${y - 4}`, { stroke: "#7A604B", sw: 1.6 }),
    circle(c, y - 40, 3.5, { fill: "#7A604B" }),
    rect(x, y, w, h, { rx: 2, fill: "#251B15" }),
    rect(x + 6, y + 12, w - 12, h - 24, { rx: 1, stroke: "#5C4535", sw: 1.2 }),
    glyph ? xian(c, y + 62, 50, EMBER.orange) : "",
    ...marks,
    rect(c - 9, y + h - 66, 18, 18, { rx: 2, fill: EMBER.deep, opacity: 0.85 }),
    rect(x - 9, y - 7, w + 18, 13, { rx: 6, fill: "#3D2D21", stroke: "#120C08", sw: 1 }),
    rect(x - 7, y + h - 5, w + 14, 13, { rx: 6, fill: "#3D2D21", stroke: "#120C08", sw: 1 }),
  ].join("");
}

/** One glaring toad eye (candidate 1's design): a gold iris that fills the eye, a horizontal pupil, a heavy lid, and three
 *  orange blade markings that flick out to the temple. side 1 is the right eye; side -1 mirrors it for the left. */
const EYE = "M-150 22 C-104 -44 40 -86 152 -18 C116 60 -46 96 -150 22 Z";
function sageEye(cx, cy, s, side, id, n) {
  const P = (d) => tp(d, cx, cy, s, side);
  const box = (x, y, w, h, o) => rect(f1(side > 0 ? cx + x * s : cx - (x + w) * s), f1(cy + y * s), f1(w * s), f1(h * s), { ...o, rx: f1((o.rx ?? 0) * s) });
  const mark = (d) => `<path d="${P(d)}" fill="url(#${id}-mark${side > 0 ? "R" : "L"})" filter="url(#${id}-glow)"/>`;
  const veins = Array.from({ length: 24 }, (_, i) => { const a = (i / 24) * 2 * Math.PI + 0.05; return `M${f1(4 + Math.cos(a) * 34)} ${f1(8 + Math.sin(a) * 18)} L${f1(4 + Math.cos(a) * 130)} ${f1(8 + Math.sin(a) * 90)}`; }).join(" ");
  return [
    `<defs><clipPath id="${id}-eye${n}"><path d="${P(EYE)}"/></clipPath></defs>`,
    mark("M-136 -58 C-56 -110 84 -146 248 -152 C104 -124 -16 -92 -136 -58 Z"),
    mark("M-158 18 C-108 -62 40 -110 162 -40 L242 -90 L188 -2 C60 40 -60 40 -150 22 Z"),
    mark("M-24 94 C72 98 162 68 244 28 C172 58 84 80 -24 94 Z"),
    `<path d="${P(EYE)}" fill="url(#${id}-iris)"/>`,
    `<g clip-path="url(#${id}-eye${n})">`,
    `<path d="${P(veins)}" fill="none" stroke="#7A3203" stroke-width="${f1(2 * s)}" opacity="0.3"/>`,
    `<g class="pulse">${box(-82, -19, 172, 54, { rx: 27, fill: "#FFF1A8", opacity: 0.5 })}</g>`,
    box(-68, -7, 144, 30, { rx: 15, fill: EMBER.void }),
    box(-160, -100, 330, 100, { fill: `url(#${id}-lid)` }),
    `</g>`,
    `<path d="${P(EYE)}" fill="none" stroke="${EMBER.void}" stroke-width="${f1(7 * s)}"/>`,
    `<path d="${P("M-146 2 C-96 -62 40 -106 160 -40")}" fill="none" stroke="${EMBER.void}" stroke-width="${f1(6 * s)}" stroke-linecap="round"/>`,
    ellipse(f1(cx - side * 30 * s), f1(cy - 20 * s), f1(11 * s), f1(5.5 * s), { fill: "#FFFFFF", opacity: 0.92 }),
    circle(f1(cx - side * 8 * s), f1(cy - 27 * s), f1(2.8 * s), { fill: "#FFFFFF", opacity: 0.8 }),
  ].join("");
}

// The toad sage, in local units: the origin is between the eyes; the hero draws it at 1 unit = 1 px.
const SAGE = {
  robe: "M-132 92 C-168 100 -206 118 -222 170 C-236 222 -242 300 -256 364 C-262 396 -246 414 -206 420 C-110 432 110 432 206 420 C246 414 262 396 256 364 C242 300 236 222 222 170 C206 118 168 100 132 92 Z",
  bust: "M-132 92 C-168 100 -206 118 -222 170 L-230 236 L230 236 L222 170 C206 118 168 100 132 92 Z",
  lap: "M-282 384 C-266 338 -150 324 0 336 C150 324 266 338 282 384 C290 414 258 432 216 434 L-216 434 C-258 432 -290 414 -282 384 Z",
  hood: "M0 -178 C26 -168 94 -142 124 -64 C142 -18 148 40 154 98 C122 116 70 124 0 124 C-70 124 -122 116 -154 98 C-148 40 -142 -18 -124 -64 C-94 -142 -26 -168 0 -178 Z",
  hoodRim: "M-150 70 C-146 20 -140 -20 -124 -64 C-94 -142 -26 -168 0 -178 C26 -168 94 -142 124 -64 C140 -20 146 20 150 70",
  opening: "M0 -102 C58 -102 98 -62 106 -12 C112 34 108 84 98 112 C70 128 -70 128 -98 112 C-108 84 -112 34 -106 -12 C-98 -62 -58 -102 0 -102 Z",
  openingRim: "M-98 112 C-108 84 -112 34 -106 -12 C-98 -62 -58 -102 0 -102 C58 -102 98 -62 106 -12 C112 34 108 84 98 112",
  face: "M-100 -28 C-108 10 -106 52 -90 82 C-68 112 -30 122 0 122 C30 122 68 112 90 82 C106 52 108 10 100 -28 C80 -66 -80 -66 -100 -28 Z",
  brow: "M-108 -40 C-84 -46 -48 -36 -6 -8 C-40 -20 -76 -26 -108 -24 Z",
  browLight: "M-104 -43 C-80 -47 -48 -38 -12 -14",
  mouth: "M-102 72 C-72 58 -34 56 0 58 C34 56 72 58 102 72",
  lip: "M-90 77 C-64 67 -32 65 0 67 C32 65 64 67 90 77",
  corner: "M-102 72 C-105 78 -104 86 -99 93",
  sleeve: "M-214 172 C-242 236 -242 304 -208 326 C-170 344 -118 312 -80 284 L-80 222 C-112 232 -146 238 -168 224 C-184 212 -190 194 -188 172 Z",
  sleeveLight: "M-212 176 C-238 238 -238 300 -206 320",
  cuff: "M-80 284 C-96 272 -96 236 -80 222 C-64 232 -64 270 -80 284 Z",
  foot: [["M-70 418 C-84 424 -98 428 -110 430", -110, 430, 6], ["M-66 422 C-74 430 -82 436 -88 440", -88, 440, 6], ["M-58 424 C-60 432 -62 438 -64 444", -64, 444, 5.5]],
  palm: "M-68 254 C-74 228 -62 200 -42 192 C-28 196 -20 212 -18 230 C-24 248 -44 260 -68 254 Z",
  fingers: [["M-58 222 C-58 210 -56 200 -52 190", -52, 190, 5], ["M-52 212 C-48 198 -44 186 -38 174", -38, 174, 5.6], ["M-46 204 C-40 186 -32 170 -22 155", -22, 155, 6], ["M-40 198 C-30 176 -18 156 -6 140", -6, 140, 6.5]],
  thumb: ["M-28 232 C-20 230 -12 228 -4 226", -4, 226, 6],
};

/** The toad sage: a stern toad in a dark hooded robe, seated and meditating, its toad hands joined in a triangle.
 *  Under the hood: two glowing gold toad eyes with horizontal pupils and orange sage markings. Original shapes.
 *  (cx, cy) is the point between the eyes. bust draws only the hood, the face and the shoulders. */
function toadSage(cx, cy, s, id, { bust = false } = {}) {
  const P = (d, flip = 1) => tp(d, cx, cy, s, flip);
  const X = (x) => f1(cx + x * s), Y = (y) => f1(cy + y * s), R = (n) => f1(n * s);
  const both = (d, attrs) => [-1, 1].map((fl) => `<path d="${P(d, -fl)}" ${attrs}/>`).join("");
  const r = seeded(11);
  const out = [];
  out.push(`<g class="pulse"><ellipse cx="${X(0)}" cy="${Y(bust ? 20 : 90)}" rx="${R(bust ? 210 : 300)}" ry="${R(bust ? 160 : 280)}" fill="url(#${id}-haze)" opacity="0.48"/></g>`);
  if (!bust) {
    const strands = [];
    for (let i = 0; i < 16; i++) {
      const u = i / 15, x = -230 + 460 * u + (r() - 0.5) * 30, ax = Math.abs(x), y0 = 8 + (ax <= 124 ? -178 + 114 * (ax / 124) ** 2 : ax <= 154 ? -64 + (ax - 124) * 5.4 : 98 + (ax - 154) * 0.9), h = 70 + r() * 120, w = 10 + r() * 18;
      strands.push(`<path d="M${X(x)} ${Y(y0)} C${X(x - w)} ${Y(y0 - h * 0.35)} ${X(x + w)} ${Y(y0 - h * 0.65)} ${X(x + (r() - 0.5) * 16)} ${Y(y0 - h)}" fill="none" stroke="${i % 3 ? EMBER.orange : EMBER.gold}" stroke-width="${R(1.4 + r() * 2.2)}" stroke-linecap="round" opacity="${f1(0.18 + r() * 0.26)}"/>`);
    }
    out.push(`<g class="pulse" filter="url(#${id}-glow)">${strands.join("")}</g>`);
  }
  if (bust) out.push(`<path d="${P(SAGE.bust)}" fill="url(#${id}-bust)"/>`);
  else {
    out.push(`<path d="${P(SAGE.robe)}" fill="url(#${id}-robe)"/>`);
    out.push(both("M-200 206 C-212 262 -216 322 -228 374", `fill="none" stroke="#3A2C21" stroke-width="${R(3)}" stroke-linecap="round"`));
    out.push(`<path d="${P(SAGE.lap)}" fill="url(#${id}-robe)" stroke="#0A0705" stroke-width="${R(1.5)}"/>`);
    out.push(both("M-262 398 C-200 372 -120 366 -40 380", `fill="none" stroke="#3A2C21" stroke-width="${R(3)}" stroke-linecap="round"`));
    out.push(path(P("M-36 392 C-14 406 14 406 36 392"), { stroke: "#3A2C21", sw: R(2.5) }));
  }
  out.push(both("M-150 96 C-178 104 -208 122 -222 172", `fill="none" stroke="#F2C88C" stroke-width="${R(2.2)}" opacity="0.45" stroke-linecap="round"`));
  // The lapels, with an ember trim, and the prayer beads.
  out.push(both("M-120 104 C-92 132 -60 170 -26 226", `fill="none" stroke="${EMBER.deep}" stroke-width="${R(3.2)}" opacity="0.8" stroke-linecap="round"`));
  if (!bust) for (let i = 0; i <= 14; i++) {
    const u = i / 14, bx = -86 + 172 * u, by = 112 + 38 * Math.sin(Math.PI * u);
    out.push(circle(X(bx), Y(by), R(6.4), { fill: i === 7 ? EMBER.deep : "#3B2B1F", stroke: "#0A0705", sw: R(1) }) + circle(X(bx - 2), Y(by - 2), R(2), { fill: "#9A7A5C", opacity: 0.45 }));
  }
  // The hood: a dark cowl with a moonlit rim and folds, and a deep shadow inside.
  out.push(`<path d="${P(SAGE.hood)}" fill="url(#${id}-hood)"/>`);
  out.push(both("M-62 -148 C-92 -112 -114 -62 -124 0", `fill="none" stroke="#4A392B" stroke-width="${R(2.5)}" opacity="0.8" stroke-linecap="round"`));
  out.push(path(P("M0 -178 C3 -152 2 -128 0 -106"), { stroke: "#4A392B", sw: R(2.5), opacity: 0.8 }));
  out.push(`<path d="${P(SAGE.hoodRim)}" fill="none" stroke="#F2C88C" stroke-width="${R(2.6)}" opacity="0.6" filter="url(#${id}-glow)"/>`);
  out.push(`<path d="${P(SAGE.opening)}" fill="#040202"/>`, `<path d="${P(SAGE.openingRim)}" fill="none" stroke="#3E2F23" stroke-width="${R(7)}"/>`);
  // The face: a wide toad head, dark under the hood, lit from below by its eyes.
  out.push(`<path d="${P(SAGE.face)}" fill="url(#${id}-skin)"/>`);
  out.push([-1, 1].map((sd) => ellipse(X(sd * 88), Y(38), R(14), R(26), { fill: "#3A291C", opacity: 0.85 }) + path(P(`M${sd * 76} 16 C${sd * 72} 34 ${sd * 74} 54 ${sd * 82} 64`), { stroke: "#120C08", sw: R(1.6), opacity: 0.7 }) + [[0, 26], [-5, 40], [4, 50], [-2, 56]].map(([dx, dy]) => circle(X(sd * (88 + dx)), Y(dy + 4), R(2.6), { fill: "#1D130C" })).join("")).join(""));
  const mouthY = (x) => 58 + 12 * (x / 98) ** 2;
  for (let i = 0; i < 90; i++) {
    const x = (r() * 2 - 1) * 100, y = 6 + r() * 112, rr = 1.5 + r() * 2.8;
    const inFace = (x / 100) ** 2 + ((y - 44) / 76) ** 2 < 0.9;
    if (!inFace || (Math.abs(Math.abs(x) - 46) < 36 && y < 26) || Math.abs(y - mouthY(x)) < 8 || (Math.abs(x) < 22 && Math.abs(y - 34) < 9)) continue;
    out.push(circle(X(x), Y(y), R(rr), { fill: "#1D130C", opacity: 0.85 }) + circle(X(x - rr * 0.3), Y(y - rr * 0.35), R(rr * 0.45), { fill: "#9A7050", opacity: 0.5 }));
  }
  out.push(both(SAGE.brow, `fill="#120B07"`));
  out.push(both(SAGE.browLight, `fill="none" stroke="${EMBER.hot}" stroke-width="${R(1.6)}" opacity="0.6" stroke-linecap="round"`));
  out.push(`<g class="pulse">${[-1, 1].map((sd) => `<ellipse cx="${X(sd * 50)}" cy="${Y(2)}" rx="${R(46)}" ry="${R(22)}" fill="${EMBER.orange}" opacity="0.45" filter="url(#${id}-blur)"/>`).join("")}</g>`);
  out.push(sageEye(X(-46), Y(2), 0.17 * s, -1, id, 1), sageEye(X(46), Y(2), 0.17 * s, 1, id, 2));
  out.push([-1, 1].map((sd) => ellipse(X(sd * 11), Y(34), R(3.6), R(2.2), { fill: "#070403" })).join(""));
  out.push(path(P(SAGE.lip), { stroke: "#8A6242", sw: R(1.6), opacity: 0.55 }));
  out.push(path(P(SAGE.mouth), { stroke: EMBER.void, sw: R(4.5) }));
  out.push(both(SAGE.corner, `fill="none" stroke="${EMBER.void}" stroke-width="${R(3.2)}" stroke-linecap="round"`));
  if (bust) return out.join("");
  // The sleeves, and the toad hands joined in a triangle around a seed of natural energy. The hands are drawn
  // 1.2 times larger, about the middle of the triangle (0, 196).
  out.push(both(SAGE.sleeve, `fill="url(#${id}-hood)" stroke="#080504" stroke-width="${R(2)}"`));
  out.push(both(SAGE.sleeveLight, `fill="none" stroke="#F2C88C" stroke-width="${R(2)}" opacity="0.35" stroke-linecap="round"`));
  out.push(both("M-200 304 C-166 306 -124 290 -92 270 M-178 250 C-150 256 -120 250 -96 240", `fill="none" stroke="#120C08" stroke-width="${R(2.5)}" opacity="0.8" stroke-linecap="round"`));
  out.push(both(SAGE.cuff, `fill="#070504" stroke="#4A392B" stroke-width="${R(1.5)}"`));
  out.push(`<g class="pulse"><ellipse cx="${X(0)}" cy="${Y(190)}" rx="${R(36)}" ry="${R(48)}" fill="${EMBER.hot}" opacity="0.48" filter="url(#${id}-blur)"/></g>`);
  out.push(circle(X(0), Y(194), R(6), { fill: "#FFE3A6", opacity: 0.9 }), circle(X(0), Y(194), R(13), { fill: EMBER.gold, opacity: 0.3 }));
  const k = 1.2 * s, hy = cy + 196 * s * (1 - 1.2);
  const HX = (x) => f1(cx + x * k), HY = (y) => f1(hy + y * k), HR = (n) => f1(n * k);
  const digit = (Q, sd) => ([d, tx, ty, pr]) =>
    `<path d="${Q(d)}" fill="none" stroke="#0E0906" stroke-width="${HR(12)}" stroke-linecap="round"/><path d="${Q(d)}" fill="none" stroke="#6A4A31" stroke-width="${HR(8)}" stroke-linecap="round"/>` +
    circle(HX(sd * tx), HY(ty), HR(pr), { fill: "#9A7048", stroke: "#0E0906", sw: HR(1.5) }) + circle(HX(sd * (tx - 1.4)), HY(ty - 1.8), HR(pr * 0.42), { fill: "#E2B888", opacity: 0.75 });
  for (const sd of [-1, 1]) {
    const Q = (d) => tp(d, cx, hy, k, sd);
    out.push(SAGE.fingers.map(digit(Q, sd)).join(""));
    out.push(`<path d="${Q(SAGE.palm)}" fill="#5A3F29" stroke="#0E0906" stroke-width="${HR(1.6)}"/>`);
    out.push(path(Q("M-62 222 C-56 208 -48 199 -38 195"), { stroke: "#B08458", sw: HR(1.8), opacity: 0.7 }));
    out.push(digit(Q, sd)(SAGE.thumb));
    out.push([[-50, 236, 2.4], [-38, 214, 2], [-58, 244, 1.8], [-30, 226, 1.6]].map(([wx, wy, wr]) => circle(HX(sd * wx), HY(wy), HR(wr), { fill: "#2A1C12", opacity: 0.8 })).join(""));
  }
  // The toad feet under the robe, on the rock.
  for (const sd of [-1, 1]) out.push(SAGE.foot.map(([d, tx, ty, pr]) =>
    `<path d="${P(d, sd)}" fill="none" stroke="#0E0906" stroke-width="${R(11)}" stroke-linecap="round"/><path d="${P(d, sd)}" fill="none" stroke="#6A4A31" stroke-width="${R(7.5)}" stroke-linecap="round"/>` +
    circle(X(sd * tx), Y(ty), R(pr), { fill: "#9A7048", stroke: "#0E0906", sw: R(1.4) })).join(""));
  return out.join("");
}

// The roles on the ring, clockwise from one o'clock. The writers (true) work in their own worktrees.
const RING = [["Designer", true, "scroll"], ["PE", false, "square"], ["Implementer", true, "anvil"], ["Arena judge", true, "scales"], ["Code review", false, "lens"], ["Security", false, "shield"], ["UX review", false, "mirror"], ["QA", false, "orb"]];
// Where the spirit's hand goes for each tool, in medallion units (the medallion has a radius of 50).
const HANDS = { scroll: [10, 6], square: [13, 6], anvil: [8, 2], scales: [12, 10], lens: [9, 7], shield: [12, 6], mirror: [19, 16], orb: [18, 11] };

/** A pale, glowing toad spirit with its tool, in a medallion of radius 50·s centred on (cx, cy). */
function spirit(cx, cy, s, tool, id) {
  const P = (d) => tp(d, cx, cy, s);
  const X = (x) => f1(cx + x * s), Y = (y) => f1(cy + y * s), R = (n) => f1(n * s);
  const pale = EMBER.pale, dark = "#2E2016";
  const st = (d, w, c = pale, op) => path(P(d), { stroke: c, sw: R(w), opacity: op });
  const fl = (d, c = pale, op) => `<path d="${P(d)}" fill="${c}"${op ? ` opacity="${op}"` : ""}/>`;
  const [hx, hy] = HANDS[tool];
  // A stern spirit: slit eyes under slanted brows, a flat mouth, and a wisp of a tail.
  const toad = [
    st("M-29 16 C-40 12 -43 2 -37 -4 C-33 -8 -28 -5 -31 -1", 2.4, pale, 0.55),
    ellipse(X(-25), Y(28), R(12), R(7.5), { fill: pale, opacity: 0.9 }),
    ellipse(X(5), Y(28), R(12), R(7.5), { fill: pale, opacity: 0.9 }),
    ellipse(X(-10), Y(14), R(21), R(16), { fill: pale, opacity: 0.9 }),
    ellipse(X(-10), Y(-5), R(19.5), R(12.5), { fill: pale }),
    circle(X(-20), Y(-14), R(6.4), { fill: pale }),
    circle(X(0), Y(-14), R(6.4), { fill: pale }),
    ellipse(X(-20), Y(-13), R(3.8), R(1.9), { fill: EMBER.orange }),
    ellipse(X(0), Y(-13), R(3.8), R(1.9), { fill: EMBER.orange }),
    rect(X(-22.4), Y(-13.6), R(4.8), R(1.2), { rx: 0, fill: dark }),
    rect(X(-2.4), Y(-13.6), R(4.8), R(1.2), { rx: 0, fill: dark }),
    st("M-27 -19 L-14 -16 M7 -19 L-6 -16", 1.8, dark),
    st("M-27 0 C-16 1 -4 1 7 0 M-27 0 L-28 3 M7 0 L8 3", 1.4, dark),
    st("M-22 -24 L-17 -21 M2 -24 L-3 -21", 1.2, EMBER.deep),
    st("M-26 10 C-30 16 -30 22 -26 28", 1.3, dark, 0.5),
    st(`M2 6 C6 8 ${hx - 4} ${hy} ${hx} ${hy}`, 5.2),
    circle(X(hx + 2), Y(hy - 2), R(1.9), { fill: pale }),
    circle(X(hx + 2.6), Y(hy + 1.2), R(1.9), { fill: pale }),
  ];
  const tools = {
    scroll: [st("M14 -25 L42 -25", 3.6, EMBER.wood), fl("M17 -25 L39 -25 L39 17 L17 17 Z", pale, 0.92), st("M23 -16 C26 -12 25 -6 22 -1", 2.4, EMBER.deep), st("M31 -15 L31 4", 2, "#5A3E2A"), st("M23 7 C27 5 31 7 34 11", 2.2, EMBER.orange), st("M14 17 L42 17", 3.6, EMBER.wood), st("M4 12 L16 -4", 2.6, EMBER.wood), fl("M15 -2 C16 -7 19 -10 21 -12 C21 -8 19 -4 17 -1 Z", "#1A120C")],
    square: [`<path d="${P("M14 26 L44 26 L14 -20 Z")}" fill="${pale}" fill-opacity="0.18" stroke="${pale}" stroke-width="${R(3.2)}" stroke-linejoin="round"/>`, `<path d="${P("M19 21 L32 21 L19 1 Z")}" fill="none" stroke="${pale}" stroke-width="${R(1.6)}" stroke-linejoin="round"/>`, st("M22 26 L22 23 M28 26 L28 23.5 M34 26 L34 23 M40 26 L40 23.5", 1.1, dark), st("M14 -10 L17 -10 M14 -2 L17 -2 M14 6 L17 6", 1.1, dark)],
    anvil: [fl("M12 10 L36 10 C40 10 44 9 46 7 C44 13 40 16 34 16 L30 16 L30 22 L36 28 L14 28 L20 22 L20 16 L16 16 C13 16 12 13 12 10 Z", pale, 0.92), st("M6 2 L18 -14", 2.8, EMBER.wood), st("M12 -19 L24 -10", 6.5), `<g filter="url(#${id}-glow)">${st("M28 6 L34 -4", 1.6, EMBER.gold)}${st("M24 5 L21 -6", 1.6, EMBER.gold)}${st("M32 7 L42 0", 1.6, EMBER.hot)}${st("M30 5 L38 -9", 1.2, EMBER.orange)}${circle(X(36), Y(-9), R(1.4), { fill: EMBER.gold })}${circle(X(43), Y(-3), R(1.2), { fill: EMBER.gold })}${circle(X(19), Y(-5), R(1.2), { fill: EMBER.hot })}</g>`],
    scales: [st("M25 -27 L25 24", 2.6), st("M17 26 L33 26", 3.6), circle(X(25), Y(-28), R(2.8), { fill: pale }), st("M11 -18 L39 -18", 2.4), st("M11 -18 L5 0 M11 -18 L17 0 M39 -18 L33 0 M39 -18 L45 0", 1.1), fl("M3 0 L19 0 C17 6 5 6 3 0 Z"), fl("M31 0 L47 0 C45 6 33 6 31 0 Z"), circle(X(39), Y(-3), R(2.2), { fill: EMBER.gold })],
    lens: [st("M9 7 L18 -2", 3.8, EMBER.wood), circle(X(25), Y(-10), R(10.5), { fill: pale, opacity: 0.2 }), circle(X(25), Y(-10), R(10.5), { stroke: pale, sw: R(3) }), st("M19 -14 C20 -16 23 -17 25 -17", 1.4, "#FFFFFF")],
    shield: [fl("M28 -24 C34 -20 40 -20 44 -20 C44 -2 40 14 28 24 C16 14 12 -2 12 -20 C16 -20 22 -20 28 -24 Z", pale, 0.92), `<path d="${P("M28 -18 C32 -15 36 -15 39 -15 C39 -2 36 10 28 17 C20 10 17 -2 17 -15 C20 -15 24 -15 28 -18 Z")}" fill="none" stroke="${dark}" stroke-width="${R(1)}" opacity="0.5"/>`, circle(X(28), Y(-5), R(3.6), { fill: EMBER.orange }), fl("M26.4 -3 L29.6 -3 L31 7 L25 7 Z", EMBER.orange)],
    mirror: [st("M27 5 L22 21", 4, EMBER.wood), circle(X(21.6), Y(23), R(2.6), { fill: EMBER.gold }), `<ellipse cx="${X(28)}" cy="${Y(-10)}" rx="${R(11)}" ry="${R(14)}" fill="#3A4650" stroke="${EMBER.gold}" stroke-width="${R(3.4)}"/>`, circle(X(28), Y(-25.5), R(2.4), { fill: EMBER.gold }), st("M22 -16 L31 -3", 2, "#FFFFFF", 0.75), st("M27 -19 L33 -11", 1.3, "#FFFFFF", 0.55), ellipse(X(31), Y(-6), R(3), R(2), { fill: EMBER.orange, opacity: 0.8 })],
    orb: [`<circle cx="${X(25)}" cy="${Y(0)}" r="${R(16)}" fill="${EMBER.orange}" opacity="0.4" filter="url(#${id}-glow)"/>`, circle(X(25), Y(0), R(9.5), { fill: `url(#${id}-orb)` }), circle(X(22), Y(-3), R(2.6), { fill: "#FFFFFF", opacity: 0.8 })],
  };
  return toad.join("") + tools[tool].join("");
}

/** A medallion: a dark disc with a pale rim and a toad spirit. A writer's medallion has a brighter, gold rim. */
function medallion(x, y, r, tool, writes, id) {
  return [
    `<g class="pulse"><circle cx="${x}" cy="${y}" r="${f1(r + Math.min(16, r * 0.4))}" fill="${writes ? EMBER.orange : "#E8C9A0"}" opacity="${writes ? 0.34 : 0.14}" filter="url(#${id}-blur)"/></g>`,
    circle(x, y, r + 8, { stroke: writes ? EMBER.gold : "#CDB89A", sw: 1, opacity: 0.45 }),
    circle(x, y, r, { fill: `url(#${id}-disc)`, stroke: writes ? EMBER.gold : "#D9C3A3", sw: writes ? 3.6 : 1.8 }),
    circle(x, y, r - 6, { stroke: writes ? EMBER.orange : "#6E5844", sw: 1.2, opacity: 0.75 }),
    `<g filter="url(#${id}-glow)">${spirit(x, y + 2, r / 50, tool, id)}</g>`,
  ].join("");
}

/** A name plaque: a dark tablet with the label. anchor says which edge x is: "start", "middle" or "end". */
function plaque(x, y, label, writes, anchor = "middle", o = {}) {
  const size = o.size ?? 26, w = Math.round(label.length * size * 0.6 + 36), h = o.h ?? 44;
  const x0 = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
  return rect(f1(x0), f1(y - h / 2), w, h, { rx: 8, fill: o.fill ?? "#110B08", stroke: writes ? EMBER.gold : "#8E7560", sw: writes ? 2.2 : 1.4 }) +
    text(f1(x0 + w / 2), f1(y + size * 0.35), label, { size, weight: o.weight ?? 700, fill: o.ink ?? EMBER.ink, anchor: "middle", ls: o.ls });
}

/** Half of the loop (the upper half behind the sage, or the lower half in front), clockwise, with its arrowheads. */
function ringHalf(cx, cy, rx, ry, front, id) {
  const [x0, x1] = front ? [cx + rx, cx - rx] : [cx - rx, cx + rx];
  const d = `M${x0} ${cy} A${rx} ${ry} 0 0 1 ${x1} ${cy}`;
  const arrows = (front ? [135, 180, 225] : [270, 315, 0, 45, 90]).map((deg) => {
    const a = (deg * Math.PI) / 180, px = cx + rx * Math.sin(a), py = cy - ry * Math.cos(a);
    let dx = rx * Math.cos(a), dy = ry * Math.sin(a);
    const n = Math.hypot(dx, dy);
    dx /= n; dy /= n;
    return `<path d="M${f1(px + dx * 11)} ${f1(py + dy * 11)} L${f1(px - dx * 7 - dy * 8)} ${f1(py - dy * 7 + dx * 8)} L${f1(px - dx * 3)} ${f1(py - dy * 3)} L${f1(px - dx * 7 + dy * 8)} ${f1(py - dy * 7 - dx * 8)} Z" fill="${EMBER.gold}"/>`;
  });
  return `<path d="${d}" fill="none" stroke="${EMBER.orange}" stroke-width="7" opacity="0.3" filter="url(#${id}-glow)"/>` + path(d, { stroke: "#F3DDB0", sw: 2.2, opacity: 0.85 }) + arrows.join("");
}

/** A dark world panel: the defs, the slow glow (off for readers who ask for less motion), and a rounded frame. */
function worldSvg(w, h, id, defs, body, label, o = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">
${pulseCss}
<defs>
${defs}
<clipPath id="${id}-frame"><rect width="${w}" height="${h}" rx="${o.rx ?? 28}"/></clipPath>
</defs>
<g clip-path="url(#${id}-frame)">
<rect width="${w}" height="${h}" rx="${o.rx ?? 28}" fill="${o.bg ?? `url(#${id}-sky)`}"/>
${body}
</g>
${o.border ? `<rect x="0.75" y="0.75" width="${w - 1.5}" height="${h - 1.5}" rx="${(o.rx ?? 28) - 0.75}" fill="none" stroke="${o.border}" stroke-width="1.5"/>` : ""}
</svg>
`;
}

/** The hero: the hooded toad sage meditates on a rock, ringed by its eight roles on an arrowed loop, in a misty
 *  mountain world. A title band on top, a footer band below. Dark in both themes. */
function hero(t) {
  const W = 1280, H = 1120, id = `hero-${t === THEMES.dark ? "d" : "l"}`;
  const cx = 640, cy = 640, rx = 470, ry = 330, mr = 58, eyeY = 520;
  const r = seeded(5);
  const far = ridge(seeded(21), W, H, 650, 110, 270, 70, 150);
  const mid = ridge(seeded(34), W, H, 790, 90, 250, 90, 170);
  const near = ridge(seeded(55), W, H, 930, 60, 200, 110, 200);
  const at = (k) => { const a = ((22.5 + k * 45) * Math.PI) / 180; return [f1(cx + rx * Math.sin(a)), f1(cy - ry * Math.cos(a))]; };
  const meds = RING.map(([name, writes, tool], k) => ({ name, writes, tool, xy: at(k) }));
  // Plaques face away from the sage: outward for the top and bottom pairs, below for the four at the sides.
  const plaqueOf = ({ name, writes, xy: [x, y] }, k) =>
    k === 0 || k === 3 ? plaque(x + mr + 12, y, name, writes, "start") :
    k === 4 || k === 7 ? plaque(x - mr - 12, y, name, writes, "end") :
    plaque(x, y + mr + 32, name, writes);
  const body = [
    // The sky, the moon and the far world.
    embers(r, 70, W, 20, 640),
    `<circle cx="${cx}" cy="470" r="300" fill="url(#${id}-moonglow)" opacity="0.4"/>`,
    `<circle cx="${cx}" cy="470" r="212" fill="url(#${id}-moon)" opacity="0.46"/>`,
    [[-70, -60, 30], [60, 40, 22], [-20, 90, 16], [95, -80, 14], [-110, 40, 12]].map(([dx, dy, cr]) => circle(cx + dx, 470 + dy, cr, { fill: "#8A6444", opacity: 0.18 })).join(""),
    `<path d="${far.d}" fill="#7A5E48" opacity="0.36"/>`,
    far.tops.filter((_, i) => i % 2).map(([x, y]) => pine(x, y + 2, 1.3, "#6A5040", 0.4)).join(""),
    mist(600, id, r, 0.22),
    pagoda(330, 612, 1.5, "#1E1611", 0.48, id), pagoda(960, 652, 1.7, "#1E1611", 0.48, id),
    waterfall(376, 622, 800, 9, id), waterfall(906, 662, 830, 11, id), waterfall(1140, 560, 770, 7, id), waterfall(142, 600, 760, 6, id),
    `<path d="${mid.d}" fill="#4A382A" opacity="0.44"/>`,
    mid.tops.filter((_, i) => i % 3 === 1).map(([x, y]) => pine(x, y + 2, 1.6, "#3A2C21", 0.45)).join(""),
    mist(760, id, r, 0.24),
    `<path d="${near.d}" fill="#17110D" opacity="0.48"/>`,
    mist(900, id, r, 0.24),
    // The hanging scrolls.
    banner(26, 268, 72, 620, seeded(3), true), banner(1182, 268, 72, 620, seeded(9), false),
    // The guide line from the title band down to the loop.
    path(`M${cx} 226 L ${cx} 292`, { stroke: "#F3DDB0", sw: 1.2, opacity: 0.4 }), circle(cx, 248, 7, { stroke: EMBER.gold, sw: 1.6, opacity: 0.8 }),
    // The loop behind the sage, the sage on its rock, and the loop in front.
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx + 34}" ry="${ry + 30}" fill="none" stroke="#C9A27A" stroke-width="1.2" stroke-dasharray="2 10" opacity="0.28"/>`,
    ringHalf(cx, cy, rx, ry, false, id),
    toadSage(cx, eyeY, 1, id),
    `<path d="M380 1060 L402 1004 C410 978 420 958 452 952 L828 952 C860 958 870 978 878 1004 L900 1060 Z" fill="url(#${id}-rock)"/>`,
    path("M452 952 L828 952", { stroke: EMBER.deep, sw: 2, opacity: 0.6 }),
    path("M470 980 L500 1010 L488 1040 M780 976 L800 1006 M620 1046 L650 1040", { stroke: "#0A0705", sw: 2, opacity: 0.6 }),
    ringHalf(cx, cy, rx, ry, true, id),
    // The team: eight medallions on the loop.
    ...meds.map((m) => medallion(m.xy[0], m.xy[1], mr, m.tool, m.writes, id)),
    mist(1048, id, r, 0.14),
    // The footer band.
    rect(0, 1060, W, 60, { rx: 0, fill: "#0A0706" }),
    path(`M0 1060 L ${W} 1060`, { stroke: EMBER.deep, sw: 1.5, opacity: 0.7 }),
    // The words.
    `<text x="64" y="176" font-family="${SANS}" font-size="152" font-weight="900" letter-spacing="-6" fill="url(#${id}-word)" filter="url(#${id}-wordglow)">sage</text>`,
    text(452, 90, ["Your chief of staff", "for Claude Code."], { size: 46, weight: 800, fill: EMBER.ink, lh: 1.12, ls: -0.5 }),
    `<text x="454" y="190" font-family="${SANS}" font-size="28" fill="${EMBER.muted}"><tspan>Start a message with </tspan><tspan font-weight="800" fill="${EMBER.hot}">“sage mode”</tspan><tspan>.</tspan></text>`,
    ...meds.map(plaqueOf),
    `<rect x="${cx - 128}" y="990" width="256" height="48" rx="8" fill="url(#${id}-chief)" filter="url(#${id}-glow)"/>`,
    text(cx, 1023, "Chief of staff", { size: 28, weight: 800, fill: "#160902", anchor: "middle" }),
    rect(40, 1068, 390, 44, { rx: 8, stroke: EMBER.orange, sw: 1.5 }),
    text(235, 1099, "Claude Code plugin · MIT", { size: 26, weight: 700, fill: EMBER.hot, anchor: "middle" }),
    text(W - 40, 1099, "Built on pstack and poteto mode, by Lauren Tan", { size: 26, fill: EMBER.muted, anchor: "end" }),
  ].join("\n");
  return worldSvg(W, H, id, worldDefs(id), body, "sage: your chief of staff for Claude Code. Start a message with sage mode. A hooded toad sage, the chief of staff, meditates on a rock in a misty mountain world, with glowing gold toad eyes. Around it, its team on a loop: designer, PE, implementer, arena judge, code review, security, UX review and QA. Claude Code plugin, MIT. Built on pstack and poteto mode, by Lauren Tan.", { border: t === THEMES.dark ? "#3A2414" : undefined });
}

/** How it works: you, the chief of staff (the toad sage), the team's flow to a pull request, the store, and the outer
 *  loop. The same world, simpler: ink-wash peaks on parchment in the light version, misty peaks at night in the dark. */
function loop(t) {
  const dark = t === THEMES.dark, id = `loop-${dark ? "d" : "l"}`;
  const c = dark
    ? { bg: "#0C0806", hill: "#3A2B21", hillOp: 0.45, mistC: "#E9D6BC", mistOp: 0.08, moonOp: 0.3, moonDisc: 0.22, tile: "#17100C", panel: "#120C08", ink: "#FFF3E6", muted: "#CDB6A0", line: "#8A705C", edge: EMBER.orange, bad: "#FF6A55", loop: EMBER.gold, glowOp: 0.5, border: "#3A2414" }
    : { bg: "#FAF6F0", hill: "#8C7867", hillOp: 0.2, mistC: "#FFFFFF", mistOp: 0.7, moonOp: 0.4, moonDisc: 0.3, tile: "#FFFFFF", panel: "#FFF3E6", ink: "#1A0E07", muted: "#6B5242", line: "#A88B75", edge: "#E5600B", bad: "#C7361F", loop: "#B4470C", glowOp: 0.25, border: "#E8D9C6" };
  const W = 1100, H = 864;
  const mk = (name, color) => `<marker id="${id}-${name}" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L12 6 L0 12 L3 6 z" fill="${color}"/></marker>`;
  const defs = [worldDefs(id), mk("hot", c.edge), mk("muted", c.line), mk("bad", c.bad), mk("loop", c.loop), `<clipPath id="${id}-chiefclip"><rect x="402" y="26" width="296" height="276" rx="7"/></clipPath>`].join("\n");
  const line = (d, color, marker, o = {}) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${o.sw ?? 2.5}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ""} stroke-linecap="round" stroke-linejoin="round"${marker ? ` marker-end="url(#${id}-${marker})"` : ""}/>`;
  const label = (x, y, s, o = {}) => text(x, y, s, { size: 22, fill: o.fill ?? c.muted, anchor: o.anchor ?? "middle", weight: o.weight, lh: 1.2, ls: o.ls });
  /** A tile with a glowing orange edge (hot) or a plain one; titleY is its title's offset from the top. */
  const tile = (x, y, w, h, title, sub, hot, titleY = 40) =>
    (hot ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="none" stroke="${c.edge}" stroke-width="4" opacity="${c.glowOp}" filter="url(#${id}-glow)"/>` : "") +
    rect(x, y, w, h, { rx: 8, fill: c.tile, stroke: hot ? c.edge : c.line, sw: hot ? 2 : 1.5 }) +
    text(x + w / 2, y + titleY, title, { size: 26, weight: 800, fill: c.ink, anchor: "middle" }) +
    text(x + w / 2, y + titleY + 34, sub, { size: 22, fill: c.muted, anchor: "middle", lh: 1.25 });
  const r = seeded(8);
  const hills = ridge(seeded(77), W, H, 864, 90, 260, 80, 170);
  const hills2 = ridge(seeded(12), W, H, 700, 60, 200, 70, 140);

  // The team's stages, left to right, each with the medallion of its role.
  let sx = 60;
  const S = [["Design", ["designer", "PE"], 140, "scroll"], ["Build", "implementer", 150, "anvil"], ["Review", ["code", "security · UX"], 160, "lens"], ["QA", "the real app", 140, "orb"]].map(([title, sub, w, tool]) => {
    const st = { title, sub, w, tool, x: sx, c: sx + w / 2 };
    sx += w + 30;
    return st;
  });
  const [, build, review, qa] = S;
  const ty = 514, th = 140, mr = 25, panelR = qa.x + qa.w + 20;
  const body = [
    // The world: a moon behind the chief, two rows of peaks, mist.
    `<circle cx="550" cy="164" r="250" fill="url(#${id}-moonglow)" opacity="${c.moonOp}"/>`,
    `<circle cx="550" cy="164" r="186" fill="url(#${id}-moon)" opacity="${c.moonDisc}"/>`,
    `<path d="${hills2.d}" fill="${c.hill}" opacity="${f1(c.hillOp * 0.7)}"/>`,
    pagoda(964, 774, 0.95, c.hill, f1(c.hillOp * 1.8), id), pagoda(100, 840, 0.8, c.hill, f1(c.hillOp * 1.6), id),
    waterfall(176, 772, 856, 5, id), waterfall(1040, 690, 772, 5, id),
    `<path d="${hills.d}" fill="${c.hill}" opacity="${c.hillOp}"/>`,
    Array.from({ length: 4 }, (_, i) => `<ellipse cx="${f1(140 + i * 280 + r() * 60)}" cy="${f1(700 + r() * 60)}" rx="${f1(200 + r() * 80)}" ry="26" fill="${c.mistC}" opacity="${f1(c.mistOp * (0.7 + r() * 0.4))}" filter="url(#${id}-mist)"/>`).join(""),
    dark ? embers(r, 40, W, 20, 800) : "",
    // Row 1: you, the chief of staff, the store.
    tile(40, 100, 200, 112, "You", "phone · desktop", false, 46),
    line("M248 128 L 390 128", c.edge, "hot"), label(318, 114, "request"),
    line("M390 176 L 248 176", c.line, "muted"), label(318, 206, ["questions,", "results"]),
    // The chief of staff: a dark tile with the hooded toad sage, in both themes.
    `<rect x="402" y="26" width="296" height="276" rx="8" fill="${c.edge}" opacity="${c.glowOp}" filter="url(#${id}-glow)"/>`,
    rect(402, 26, 296, 276, { rx: 8, fill: "#0A0604", stroke: c.edge, sw: 2 }),
    `<g clip-path="url(#${id}-chiefclip)">${toadSage(550, 104, 0.36, id, { bust: true })}</g>`,
    text(550, 226, "Chief of staff", { size: 32, weight: 800, fill: EMBER.ink, anchor: "middle" }),
    text(550, 258, ["routes · briefs", "ledger · gates"], { size: 22, fill: "#CDB6A0", anchor: "middle", lh: 1.2 }),
    line("M706 164 L 758 164", c.line, "muted"),
    `<path d="M766 104 L766 216 A148 18 0 0 0 1062 216 L1062 104" fill="${c.tile}" stroke="${c.line}" stroke-width="1.5"/>`,
    ellipse(914, 104, 148, 18, { fill: c.tile, stroke: c.line, sw: 1.5 }),
    text(914, 166, "Store", { size: 26, weight: 800, fill: c.ink, anchor: "middle" }),
    label(914, 200, "tasks · ledger · trail"),
    // The brief goes down to the team; the report comes back up.
    line("M520 310 L 520 356", c.edge, "hot"), label(506, 342, "brief", { anchor: "end" }),
    line("M580 356 L 580 310", c.line, "muted"), label(594, 342, "report + evidence", { anchor: "start" }),
    // The team.
    rect(40, 362, panelR - 40, 386, { rx: 10, fill: c.panel, stroke: c.edge, sw: 1.5, opacity: 0.92 }),
    label(64, 400, "THE TEAM · ONE WRITER AT A TIME", { anchor: "start", fill: c.edge, weight: 800, ls: 2 }),
    line(`M${review.c} ${ty - mr - 4} C ${review.c} ${ty - mr - 44}, ${build.c} ${ty - mr - 44}, ${build.c} ${ty - mr - 6}`, c.bad, "bad"),
    label((review.c + build.c) / 2, ty - mr - 46, "findings", { fill: c.bad }),
    ...S.map((st, i) => tile(st.x, ty, st.w, th, st.title, st.sub, true, 64) + (i < S.length - 1 ? line(`M${st.x + st.w + 5} ${ty + th / 2} L ${st.x + st.w + 28} ${ty + th / 2}`, c.edge, "hot") : "")),
    ...S.map((st) => medallion(st.c, ty, mr, st.tool, false, id)),
    line(`M${qa.c} ${ty + th + 4} C ${qa.c} ${ty + th + 48}, ${build.c} ${ty + th + 48}, ${build.c} ${ty + th + 6}`, c.bad, "bad"),
    label((qa.c + build.c) / 2, ty + th + 62, "QA fail", { fill: c.bad }),
    // The pull request.
    line(`M${qa.x + qa.w + 5} ${ty + th / 2} L ${panelR + 30} ${ty + th / 2}`, c.edge, "hot"),
    tile(panelR + 36, ty - 20, W - 40 - panelR - 36, th + 40, "Pull request", ["you merge, or", "autopilot after", "2 clean cycles"], true),
    // The outer loop: a lesson that comes back twice improves the kitchen.
    line(`M1064 160 L 1072 160 Q 1080 160 1080 170 L 1080 770 Q 1080 780 1070 780 L 340 780 Q 330 780 330 770 L 330 756`, c.loop, "loop", { dash: "8 8", sw: 2.5 }),
    label(W / 2, 828, "a lesson that comes back twice → improve the kitchen", { fill: c.loop, weight: 700 }),
  ].join("\n");
  return worldSvg(W, H, id, defs, body, "How sage works: you send a request to the chief of staff, the hooded toad sage, which briefs the team (design, build, review, QA) and keeps the store. Findings and QA failures go back to the build. A clean result becomes a pull request. In the outer loop, a lesson that comes back twice improves the kitchen.", { rx: 24, bg: c.bg, border: c.border });
}

/** Your first training (5 minutes): one session, with numbered notes. Sample data. */
function walkthrough(t) {
  const px = 40, py = 40, pw = 470, ph = 640;
  const bubble = (side, y, lines, w, n) => {
    const h = 22 + lines.length * 24;
    const x = side === "you" ? px + pw - 24 - w : px + 24;
    const you = side === "you";
    return { svg: rect(x, y, w, h, { rx: 16, fill: you ? t.accent : t.chip }) + text(x + 16, y + 28, lines, { size: 16, fill: you ? "#FFFFFF" : t.ink, lh: 1.5 }), y: y + h / 2, n, x: x + w };
  };
  const b = [
    bubble("you", py + 76, ["sage mode. Ramen Finder: add a", "favourites list, and fix this week's crash."], 360, 1),
    bubble("chief", py + 160, ["T1 favourites: large · data", "T2 crash: small · input", "T2 starts now."], 300, 2),
    bubble("chief", py + 268, ["One question for T1: sync favourites", "across devices? Recommended: not now.", "Default if you don't answer: not now."], 360, 3),
    bubble("you", py + 380, ["not now"], 100, 3),
    bubble("chief", py + 438, ["T2: build → code review → security", "→ QA. Repair round 1: an empty", "search still crashed. Fixed in 4787c81."], 340, 4),
    bubble("chief", py + 550, ["T2 verified. QA ran the app: PASS.", "→ PR #41 is ready for you."], 312, 5),
  ];
  const notes = [
    [1, "Switch it on", ["Start with “sage mode”, then what you want.", "Any session: desktop, terminal, phone."]],
    [2, "The chief frames each task", ["It sizes each task and picks a route.", "A risk flag such as data or input adds", "a security review."]],
    [3, "One product question, at most", ["With a recommendation and a default.", "Engineering choices are the chief's."]],
    [4, "The team works; you don't watch code", ["Fresh agents build, review and test.", "Findings go back for repair, bounded."]],
    [5, "You get results, not code", ["Evidence, what was not checked, and", "a pull request. You merge, or autopilot."]],
  ];
  const nx = 600;
  const noteY = [96, 196, 318, 450, 566];
  const body = [
    energy(880, 360, 3, 14, t, 0.08),
    rect(px, py, pw, ph, { rx: 30, fill: t.panel, stroke: t.line, sw: 1.5 }),
    eye(px + 38, py + 32, 24, t),
    text(px + 58, py + 37, "sage mode · ~/workspace", { size: 14, fill: t.muted, mono: true }),
    path(`M${px} ${py + 58} L ${px + pw} ${py + 58}`, { stroke: t.line, sw: 1 }),
    ...b.map((x) => x.svg),
    text(px + pw, py + ph + 30, "Illustrative session, sample data", { size: 13, fill: t.faint, anchor: "end" }),
    toad(1112, 652, 38, t, { wave: true }),
    say(964, 618, 106, 42, 1072, 646, "Your turn!", t, { center: true, size: 16, weight: 750 }),
    ...notes.map(([n, title, lines], i) => {
      const y = noteY[i];
      const target = b.find((x) => x.n === n);
      return [
        path(`M${nx - 14} ${y} C ${nx - 40} ${y}, ${px + pw + 30} ${target.y}, ${px + pw + 6} ${target.y}`, { stroke: t.accent, sw: 1.5, dash: "3 5", opacity: 0.7 }),
        circle(nx + 14, y - 6, 16, { fill: t.accent }),
        text(nx + 14, y - 0.5, String(n), { size: 16, weight: 750, fill: "#FFFFFF", anchor: "middle" }),
        text(nx + 42, y, title, { size: 19, weight: 700, fill: t.ink }),
        text(nx + 42, y + 26, lines, { size: 15.5, fill: t.muted, lh: 1.45 }),
      ].join("");
    }),
  ].join("\n");
  return svg(1200, 720, t, body, "Your first training, in five minutes: an illustrative session with numbered notes. 1, switch it on. 2, the chief frames each task. 3, one product question at most. 4, the team works. 5, you get results and a pull request.");
}

/** Routes: the least route for each size of task. */
function routes(t) {
  const BLOCK = { design: "Design", pe: "PE check", approve: "You approve", build: "Build", code: "Code review", security: "Security review", ux: "UX review", qa: "QA", evidence: "Gather evidence", review: "Evidence review", propose: "A proposal to you" };
  const rows = [
    ["tiny", "one obvious edit", ["build"]],
    ["small", "one bounded change", ["build", "code", "qa"]],
    ["large", "new screens, flows or data", ["design", "pe", "approve", "build", "code", "security", "ux", "qa"]],
    ["investigate", "the cause is unknown", ["evidence", "review", "propose"]],
  ];
  const out = [];
  rows.forEach(([size, sub, blocks], i) => {
    const y = 40 + i * 86;
    out.push(text(40, y + 26, size, { size: 20, weight: 750, fill: t.ink }), text(40, y + 50, sub, { size: 14, fill: t.muted }));
    let x = 236;
    blocks.forEach((k, j) => {
      const label = BLOCK[k];
      const w = Math.round(label.length * 8.6 + 34);
      const you = k === "approve" || k === "propose";
      out.push(rect(x, y + 8, w, 44, { rx: 22, fill: you ? t.soft : t.panel, stroke: you ? t.accent : t.line, sw: you ? 2 : 1.5 }), text(x + w / 2, y + 36, label, { size: 15, weight: 600, fill: t.ink, anchor: "middle" }));
      if (j < blocks.length - 1) out.push(arrowTo(x + w + 4, y + 30, x + w + 18, y + 30, t, { sw: 1.5 }));
      x += w + 22;
    });
  });
  out.push(
    rect(40, 392, 1200, 52, { rx: 14, fill: t.chip }),
    circle(66, 418, 9, { fill: t.accent }),
    text(86, 423, "A risk flag (auth, personal data, schema, money, secrets, outside input) adds the security review. The chief may add blocks, never remove these.", { size: 15, fill: t.ink }),
  );
  return svg(1280, 470, t, out.join("\n"), "Routes by size. Tiny: build. Small: build, code review, QA. Large: design, PE check, you approve, build, code review, security review, UX review, QA. Investigate: gather evidence, evidence review, a proposal to you. A risk flag adds the security review.");
}

/** A task's life: the states, with the repair loop and the held state. */
function lifecycle(t) {
  const states = [["framed", 40], ["briefed", 190], ["building", 340], ["reviewing", 500], ["verifying", 670], ["verified", 840], ["merged", 1010]];
  const y = 110;
  const out = [];
  states.forEach(([name, x], i) => {
    const w = 130;
    const done = name === "verified" || name === "merged";
    out.push(rect(x, y, w, 50, { rx: 25, fill: done ? t.soft : t.panel, stroke: done ? t.accent : t.line, sw: done ? 2 : 1.5 }), text(x + w / 2, y + 31, name, { size: 16, weight: 650, fill: t.ink, anchor: "middle" }));
    if (i < states.length - 1) out.push(arrowTo(x + w + 4, y + 25, states[i + 1][1] - 4, y + 25, t));
  });
  out.push(
    rect(500, 236, 130, 50, { rx: 25, fill: t.panel, stroke: t.bad, sw: 1.5 }),
    text(565, 267, "repairing", { size: 16, weight: 650, fill: t.ink, anchor: "middle" }),
    path("M735 162 C 735 230, 690 262, 634 262", { stroke: t.bad, arrow: "arrow-bad" }),
    text(742, 218, ["findings to fix,", "or QA fail"], { size: 13, fill: t.bad, lh: 1.25 }),
    path("M528 236 L 552 164", { stroke: t.muted, arrow: true }),
    text(436, 300, "next round, at most 3", { size: 13, fill: t.muted }),
    rect(340, 236, 130, 50, { rx: 25, fill: t.panel, stroke: t.line, sw: 1.5, dash: "5 5" }),
    text(405, 267, "held", { size: 16, weight: 650, fill: t.ink, anchor: "middle" }),
    path("M380 162 L 380 232", { stroke: t.muted, arrow: true }),
    text(250, 214, ["a product", "question"], { size: 13, fill: t.muted, lh: 1.25 }),
    text(40, 52, "Each move is checked by the state tool. A new commit voids the verdicts, so the task is reviewed again.", { size: 15, fill: t.muted }),
    text(840, 214, ["needs 1 clean cycle;", "autopilot merges", "after 2"], { size: 13, fill: t.accent, lh: 1.3 }),
  );
  return svg(1180, 330, t, out.join("\n"), "A task's life: framed, briefed, building, reviewing, verifying, verified, merged. Findings or a QA failure send it to repairing, at most 3 rounds. A product question holds it. Verified needs one clean cycle; autopilot merges after two.");
}

/** The arena: N candidates on a mix of Claude models, a judge, one final version. */
function arena(t) {
  const out = [
    rect(40, 150, 170, 96, { rx: 14, fill: t.chief, stroke: t.accent, sw: 3 }),
    text(125, 188, "One brief", { size: 17, weight: 750, fill: t.chiefInk, anchor: "middle" }),
    text(125, 212, ["+ a rubric the", "candidates don't see"], { size: 12.5, fill: t.chiefInk, anchor: "middle", opacity: 0.85, lh: 1.3 }),
  ];
  const cands = [["Candidate 1", "Opus · fewest taps"], ["Candidate 2", "Sonnet · most control"], ["Candidate 3", "Sonnet · reuse screens"]];
  cands.forEach(([name, sub], i) => {
    const y = 50 + i * 112;
    out.push(path(`M212 198 C 260 198, 250 ${y + 38}, 296 ${y + 38}`, { stroke: t.muted, arrow: true }));
    out.push(role(300, y, 230, 76, name, true, t, sub));
    out.push(path(`M534 ${y + 38} C 580 ${y + 38}, 570 198, 616 198`, { stroke: t.muted, arrow: true }));
  });
  out.push(
    rect(620, 140, 200, 116, { rx: 14, fill: t.panel, stroke: t.accent, sw: 2 }),
    eye(660, 178, 34, t),
    text(744, 184, "Arena judge", { size: 17, weight: 750, fill: t.ink, anchor: "middle" }),
    text(720, 214, ["scores, picks a base,", "grafts the best parts"], { size: 13, fill: t.muted, anchor: "middle", lh: 1.3 }),
    arrowTo(824, 198, 880, 198, t),
    role(884, 160, 160, 76, "Final version", true, t, "one design"),
    arrowTo(1048, 198, 1090, 198, t),
    text(1096, 192, ["reviews", "and QA"], { size: 14, fill: t.muted, lh: 1.3 }),
    text(620, 300, ["All converge → keep the shared shape.", "Wildly different → re-frame the brief once, then ask you."], { size: 13.5, fill: t.muted, lh: 1.45 }),
  );
  return svg(1180, 400, t, out.join("\n"), "The arena: one brief and a hidden rubric go to three candidates on a mix of Claude models, each with a different angle. The arena judge scores them, picks a base and grafts the best parts into one final version, which then goes through reviews and QA.");
}

/** Following pstack: a weekly sync, your overrides, one build. */
function pstack(t) {
  const out = [
    role(40, 70, 210, 80, "pstack", false, t, "by Lauren Tan (poteto)"),
    arrowTo(254, 110, 330, 110, t),
    text(292, 98, "weekly", { size: 13, fill: t.muted, anchor: "middle" }),
    role(334, 70, 220, 80, "upstream/pstack", false, t, "pinned commit + licence"),
    role(334, 196, 220, 80, "principles/", true, t, "your versions win"),
    path("M558 110 C 610 110, 600 150, 646 150", { stroke: t.muted, arrow: true }),
    path("M558 236 C 610 236, 600 196, 646 196", { stroke: t.muted, arrow: true }),
    rect(650, 128, 160, 90, { rx: 14, fill: t.chief, stroke: t.accent, sw: 3 }),
    text(730, 166, "Build", { size: 18, weight: 750, fill: t.chiefInk, anchor: "middle" }),
    text(730, 192, "checks + tests", { size: 13, fill: t.chiefInk, anchor: "middle", opacity: 0.85 }),
    arrowTo(814, 173, 870, 173, t),
    role(874, 133, 180, 80, "sage plugin", false, t, "25 principles"),
    path("M730 222 L 730 296", { stroke: t.accent, dash: "5 6" }),
    rect(560, 300, 340, 70, { rx: 14, fill: t.soft, stroke: t.accent, sw: 1.5 }),
    text(730, 330, "pstack changed one of your versions?", { size: 15, weight: 650, fill: t.ink, anchor: "middle" }),
    text(730, 354, "The update waits for you. Otherwise it merges.", { size: 13.5, fill: t.muted, anchor: "middle" }),
  ];
  return svg(1100, 400, t, out.join("\n"), "Following pstack: every week, pstack's principles come into upstream/pstack at a pinned commit. Your versions in principles/ win. The build runs the checks and tests and makes the sage plugin. If pstack changed a principle you override, the update waits for you; otherwise it merges.");
}

export const GRAPHICS = {
  hero, loop, walkthrough, routes, lifecycle, arena, pstack,
  "tip-start": tip(["Start a message with “sage mode”. That's the whole hand sign.", "Mid-sentence, it does nothing. “sage mode off” works anywhere."], "The toad sage's tip: start a message with sage mode. In the middle of a sentence it does nothing; sage mode off works anywhere."),
  "tip-try": tip(["Your first training: one small, real bug, from your phone.", "Then look at the result, not the code."], "The toad sage's tip: try one small, real bug from your phone, then look at the result."),
  "tip-kitchen": tip(["A mistake that comes back twice gets a test, a check or a rule.", "That's how the kitchen gets stronger, one lesson at a time."], "The toad sage's tip: a mistake that comes back twice gets a test, a check or a rule, so the kitchen gets stronger one lesson at a time."),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(OUT, { recursive: true });
  for (const [name, draw] of Object.entries(GRAPHICS)) for (const [theme, t] of Object.entries(THEMES)) writeFileSync(join(OUT, `${name}-${theme}.svg`), draw(t));
  console.log(`drew ${Object.keys(GRAPHICS).length * 2} files in docs/assets`);
}
