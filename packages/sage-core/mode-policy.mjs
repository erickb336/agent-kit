// The mode phrases, in classified prompt text. "sage mode" (also "sage mode on"), "sage mode off" and
// "autopilot on" count only at the start of the message, so that a mention or a quote switches nothing: "sage mode
// off" also drops the git rules. "sage mode" may stand alone, end at ".", ",", ":", ";", "!" or the end of its line, or
// go on with a space and more words ("sage mode continue on the sage project"), as long as its line has no "?" and the
// next word is not "off": "sage mode?" and "sage mode online: is it a thing?" switch nothing (T194). "autopilot on" stays
// strict: it must stand alone or end at that punctuation or its line, so "autopilot on?" and "autopilot on main" switch
// nothing. "sage mode off" must not run on into a longer word ("sage mode off-topic"), and its line must have no "?"
// ("sage mode off? what does it do?"). Because a missed off is the unsafe one, any line that starts with "sage mode off"
// or "autopilot off" switches autopilot off, even as a question or in a frame. The owner's own text also switches it
// off when it mentions autopilot and has an off word anywhere. A frame does not, because its boilerplate has off words
// ("NOT a message from the user"). Off wins over on. Only OFF_LINE has the m flag: with it, "^" also matches the start
// of each later line.
const START = String.raw`^[\s"'“‘*_>-]*`;
const SP = String.raw`[^\S\r\n  ]`; // a space, a tab or an NBSP, never a line break
// A prefix that stays on its line. With the m flag, "^" matches after each line break, so a prefix that also matched
// line breaks would read each run of blank lines again from each of its lines: quadratic time on a long report (T34).
const LINE_START = String.raw`^(?:${SP}|["'“‘*_>-])*`;
const END = String.raw`(?=${SP}*(?:[.,:;!\r\n  ]|$))`;
const SAGE = String.raw`(?:enter${SP}+)?sage${SP}+mode(?:${SP}+on)?`;
const AND_AUTOPILOT = String.raw`(?:${SP}+autopilot|(?:${SP}*[.,:;!]${SP}*|${SP}+)autopilot${SP}+on)`; // "sage mode autopilot", "sage mode, autopilot on"
// The two lookaheads come before the space run, so that one space and two spaces give the same answer, and so that the
// run never backtracks into a re-scan of the line: a lookahead after a greedy run reads the line again at each step of the
// run, quadratic time on a long first line (T34, T194 cycle 1). The off guard blocks only the exact off word: "sage mode
// offline" and "sage mode office hours" turn the mode on, as any other word after the phrase does; "sage mode off-topic"
// is an off word with a hyphen, so OFF_LINE reads it as an autopilot off and SAGE_ON does not turn the mode on.
const SAGE_ON = new RegExp(`${START}${SAGE}${AND_AUTOPILOT}?(?:${END}|(?!${SP}*off\\b)(?!.*[?？])${SP}+)`, "i"); // "." stops at a line break
const OFF_LINE = new RegExp(`${LINE_START}(?:sage${SP}+mode|autopilot)${SP}+off\\b`, "im"); // in any text, at the start of any line
const SAGE_OFF = new RegExp(`${START}sage${SP}+mode${SP}+off(?![\\p{L}\\p{N}-])(?!.*\\?)`, "iu"); // "." stops at a line break
const AUTOPILOT_ON = new RegExp(`${START}(?:autopilot${SP}+on|${SAGE}${AND_AUTOPILOT})${END}`, "i");
// A first line that starts with a mode word but matches no rule gets a note (the caller), so that a miss is never silent.
const MODE_WORD = new RegExp(`${START}(?:sage${SP}+mode|autopilot)(?![\\p{L}\\p{N}])`, "iu");
// The word autopilot, and the off words in any form ("no more", "turn off", "switch off" and "hold off" have one too).
const AUTOPILOT = /\bauto[-\s]?pilots?\b/i;
const OFF_WORD = /\b(?:off|no|without|don['’]?t|do\s+not|end(?:s|ed|ing)?|quit(?:s|ting)?|exit(?:s|ed|ing)?)\b|\b(?:stop|disabl|paus|cancel|kill|halt|deactivat|abort|suspend)|\bauto[-\s]?pilots?\s*=\s*false\b/i;
const broadOff = (text) => OFF_LINE.test(text) || (AUTOPILOT.test(text) && OFF_WORD.test(text));

/** Origin is supplied by the provider; this function does not authenticate text. */
export function modeSignals({ owner, text, outside, all }) {
  if (typeof owner !== "boolean" || [text, outside, all].some(value => typeof value !== "string")) {
    throw Error("Invalid mode prompt");
  }
  return {
    sageOff: owner && SAGE_OFF.test(text),
    sageOn: owner && SAGE_ON.test(text),
    autopilotOff: OFF_LINE.test(all) || broadOff(owner ? outside : all),
    autopilotOn: owner && AUTOPILOT_ON.test(text),
    modeWord: owner && MODE_WORD.test(text),
  };
}
