// Draws the README's graphics as SVG, each in a light and a dark version (docs/assets/<name>-light.svg, -dark.svg).
// The README shows the version that matches the reader's GitHub theme. Run `npm run graphics` after a change here.
// The look is inspired by Sage Mode in Naruto (orange markings, a toad-like eye, swirling natural energy) with
// original shapes only: no characters, logos or village symbols. The mascot is an original toad sage.
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

/** The hero: the toad sage, chief of staff, above its team. */
function hero(t) {
  const cx = 944;
  const roles = [["Designer", true], ["PE", false], ["Implementer", true], ["Arena judge", true], ["Code review", false], ["Security", false], ["UX review", false], ["QA", false]];
  const nodes = roles.map(([name, writes], i) => ({ name, writes, x: 688 + (i % 4) * 132, y: 300 + Math.floor(i / 4) * 104, w: 120, h: 54 }));
  const body = [
    energy(cx, 330, 3.2, 15, t, 0.13),
    eye(130, 132, 84, t),
    text(88, 262, "sage", { size: 108, weight: 750, fill: t.ink, ls: -3 }),
    text(92, 326, ["Your chief of staff", "for Claude Code."], { size: 36, weight: 650, fill: t.ink, lh: 1.25 }),
    text(92, 440, ["Start a message with “sage mode”. A team of", "agents designs, builds, reviews and proves the", "work. You answer only the product questions."], { size: 20, fill: t.muted, lh: 1.45 }),
    rect(88, 540, 286, 40, { rx: 20, fill: t.chip, stroke: t.line, sw: 1 }),
    text(231, 566, "Claude Code plugin · MIT", { size: 16, weight: 650, fill: t.accent, anchor: "middle" }),
    text(92, 614, "Built on pstack and poteto mode, by Lauren Tan", { size: 14, fill: t.faint }),
    ...nodes.map((n) => path(`M${cx} 254 C ${cx} 280, ${n.x + n.w / 2} ${n.y - 36}, ${n.x + n.w / 2} ${n.y}`, { stroke: t.line, sw: 2 })),
    toad(cx, 152, 64, t),
    rect(cx - 82, 222, 164, 32, { rx: 16, fill: t.chief, stroke: t.accent, sw: 2 }),
    text(cx, 243, "Chief of staff", { size: 15, weight: 750, fill: t.chiefInk, anchor: "middle" }),
    say(1046, 82, 150, 52, 1010, 128, "sage mode!", t, { center: true, size: 19, weight: 750 }),
    ...nodes.map((n) => role(n.x, n.y, n.w, n.h, n.name, n.writes, t)),
    ...[0, 1, 2].map((i) => circle(nodes[7].x + 34 + i * 26, nodes[7].y + 74, 7, { fill: t.ok })),
    rect(688, 552, 14, 14, { rx: 4, fill: t.soft, stroke: t.accent, sw: 2 }),
    text(710, 564, "writes, in its own worktree", { size: 14, fill: t.muted }),
    rect(926, 552, 14, 14, { rx: 4, fill: t.panel, stroke: t.line, sw: 1.5 }),
    text(948, 564, "read-only", { size: 14, fill: t.muted }),
    circle(1052, 559, 7, { fill: t.ok }),
    text(1066, 564, "clean verdict", { size: 14, fill: t.muted }),
  ].join("\n");
  return svg(1280, 640, t, body, "sage: your chief of staff for Claude Code. The toad sage, chief of staff, says sage mode above its team: designer, PE, implementer, arena judge, code review, security, UX review and QA.");
}

/** How it works: the inner loop and the outer loop. */
function loop(t) {
  // The team's stages, left to right. Review is wider, for its three reviewers.
  let sx = 552;
  const S = [["Design", "designer · PE", 104], ["Build", "implementer", 104], ["Review", "code · security · UX", 150], ["QA", "the real app", 104]].map(([title, sub, w]) => {
    const s = { title, sub, w, x: sx, c: sx + w / 2 };
    sx += w + 20;
    return s;
  });
  const [, build, review, qa] = S;
  const end = qa.x + qa.w;
  const st = (s) => rect(s.x, 178, s.w, 76, { rx: 12, fill: t.panel, stroke: t.line, sw: 1.5 }) + text(s.c, 210, s.title, { size: 16, weight: 700, fill: t.ink, anchor: "middle" }) + text(s.c, 234, s.sub, { size: 12.5, fill: t.muted, anchor: "middle" });
  const body = [
    rect(36, 176, 140, 80, { rx: 14, fill: t.panel, stroke: t.line, sw: 1.5 }),
    text(106, 210, "You", { size: 18, weight: 700, fill: t.ink, anchor: "middle" }),
    text(106, 234, "phone · desktop", { size: 13, fill: t.muted, anchor: "middle" }),
    arrowTo(178, 198, 258, 198, t),
    text(218, 188, "request", { size: 13, fill: t.muted, anchor: "middle" }),
    arrowTo(258, 236, 178, 236, t),
    text(218, 258, ["questions,", "results"], { size: 13, fill: t.muted, anchor: "middle", lh: 1.25 }),
    rect(262, 156, 196, 120, { rx: 16, fill: t.chief, stroke: t.accent, sw: 3 }),
    text(360, 198, "Chief of staff", { size: 19, weight: 750, fill: t.chiefInk, anchor: "middle" }),
    text(360, 224, ["routes · briefs", "ledger · gates"], { size: 14, fill: t.chiefInk, anchor: "middle", opacity: 0.9 }),
    arrowTo(460, 198, 528, 198, t),
    text(494, 188, "brief", { size: 13, fill: t.muted, anchor: "middle" }),
    arrowTo(528, 238, 460, 238, t),
    text(494, 258, ["report +", "evidence"], { size: 13, fill: t.muted, anchor: "middle", lh: 1.25 }),
    rect(532, 96, end + 20 - 532, 240, { rx: 18, fill: t.soft }),
    text(552, 124, "The team · one writer at a time", { size: 14, weight: 650, fill: t.accent }),
    ...S.map((s, i) => st(s) + (i < S.length - 1 ? arrowTo(s.x + s.w + 2, 216, s.x + s.w + 16, 216, t) : "")),
    path(`M${review.c} 176 C ${review.c} 140, ${build.c} 140, ${build.c} 174`, { stroke: t.bad, arrow: "arrow-bad" }),
    text((review.c + build.c) / 2, 146, "findings", { size: 13, fill: t.bad, anchor: "middle" }),
    path(`M${qa.c} 256 C ${qa.c} 304, ${build.c} 304, ${build.c} 258`, { stroke: t.bad, arrow: "arrow-bad" }),
    text((qa.c + build.c) / 2, 318, "QA fail", { size: 13, fill: t.bad, anchor: "middle" }),
    arrowTo(end + 2, 216, end + 38, 216, t),
    rect(end + 42, 168, 124, 96, { rx: 14, fill: t.panel, stroke: t.accent, sw: 2 }),
    text(end + 104, 202, "Pull request", { size: 16, weight: 700, fill: t.ink, anchor: "middle" }),
    text(end + 104, 226, ["you merge, or", "autopilot after", "2 clean cycles"], { size: 12, fill: t.muted, anchor: "middle", lh: 1.3 }),
    path("M360 278 L 360 330", { stroke: t.line, sw: 2 }),
    `<ellipse cx="360" cy="342" rx="84" ry="12" fill="${t.panel}" stroke="${t.line}" stroke-width="1.5"/>`,
    `<path d="M276 342 L276 392 A84 12 0 0 0 444 392 L444 342" fill="${t.panel}" stroke="${t.line}" stroke-width="1.5"/>`,
    text(360, 374, "Store", { size: 15, weight: 700, fill: t.ink, anchor: "middle" }),
    text(360, 394, "tasks · ledger · trail", { size: 12.5, fill: t.muted, anchor: "middle" }),
    path("M446 280 C 500 430, 760 430, 790 338", { stroke: t.accent, dash: "6 7", arrow: "arrow-accent" }),
    text(640, 430, "a lesson that comes back twice → improve the kitchen", { size: 13.5, fill: t.accent, anchor: "middle" }),
  ].join("\n");
  return svg(end + 206, 460, t, body, "How sage works: you send a request to the chief of staff, which briefs the team (design, build, review, QA). Findings and QA failures go back to the build. A clean result becomes a pull request. Lessons improve the kitchen.");
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
    bubble("you", py + 76, ["sage mode. TrackMe: add CSV export,", "and fix this week's crash."], 340, 1),
    bubble("chief", py + 160, ["T1 export: large · data", "T2 crash: small · input", "T2 starts now."], 300, 2),
    bubble("chief", py + 268, ["One question for T1: include deleted", "trips in the export? Recommended: no.", "Default if you don't answer: no."], 340, 3),
    bubble("you", py + 380, ["no"], 58, 3),
    bubble("chief", py + 438, ["T2: build → code review → security", "→ QA. Repair round 1: an empty date", "still crashed. Fixed in 4787c81."], 340, 4),
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
