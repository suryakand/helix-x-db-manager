/*
 * Colour for the CLI's output. The engine logs plain text; the CLI colours its lines on the way out,
 * so a program calling the engine never gets escape codes. Off when the stream is not a terminal or
 * NO_COLOR is set (hasColors() honours NO_COLOR and FORCE_COLOR).
 */

type Stream = NodeJS.WriteStream;

const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
} as const;

/** A style name, or several applied together. */
export type Style = keyof typeof CODES;

/** Whether escape codes go to this stream. */
export function colorsOn(stream: Stream = process.stdout): boolean {
  return stream.isTTY === true && typeof stream.hasColors === 'function' && stream.hasColors();
}

/** `text` in the styles, or unchanged when the stream takes no colour. */
export function paint(text: string, styles: Style | Style[], stream: Stream = process.stdout): string {
  if (!text || !colorsOn(stream)) return text;
  return [styles].flat().reduce((t, s) => `\x1b[${CODES[s][0]}m${t}\x1b[${CODES[s][1]}m`, text);
}

/** The status column of `status`, by its word. */
const STATUS: Record<string, Style[]> = {
  pending: ['yellow', 'bold'],
  applied: ['green'],
  CHANGED: ['red', 'bold'],
  'self-rec': ['cyan'],
  baseline: ['blue'],
  'no file': ['magenta'],
};

/** Words that start a progress line, and their colour. */
const LEADS: Array<[RegExp, Style[]]> = [
  [/^would( \S+)?/, ['cyan', 'bold']], // dry run: would apply, would adopt, would create ...
  [/^dry run:/, ['cyan', 'bold']],
  [/^applying\b/, ['green']],
  [/^(adopted|marked|refreshed|created)\b/, ['green']],
  [/^applied \d+ file\(s\)/, ['green', 'bold']],
  [/^nothing pending/, ['green']],
  [/^new database:/, ['blue', 'bold']],
  [/^baseline:/, ['blue', 'bold']],
  [/^cancelled/, ['yellow']],
];

/** One engine progress line, coloured by what it says. */
export function paintLine(line: string, stream: Stream = process.stdout): string {
  const status = /^(\s+)(pending|applied|CHANGED|self-rec|baseline|no file)(\s)/.exec(line);
  if (status) {
    const [whole, indent, word, gap] = status;
    const rest = line.slice(whole.length).replace(/\(.*\)$/, (note) => paint(note, 'dim', stream));
    return `${indent}${paint(word, STATUS[word], stream)}${gap}${rest}`;
  }
  for (const [pattern, styles] of LEADS) {
    const m = pattern.exec(line);
    if (m) return `${paint(m[0], styles, stream)}${line.slice(m[0].length)}`;
  }
  return line;
}
