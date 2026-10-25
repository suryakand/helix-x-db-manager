import { describe, expect, it } from 'vitest';
import { paint, paintLine } from '../src/cli/colors';

const tty = { isTTY: true, hasColors: () => true } as unknown as NodeJS.WriteStream;
const pipe = { isTTY: false } as unknown as NodeJS.WriteStream;
const plain = (s: string): string => s.replace(/\x1b\[\d+m/g, '');

describe('colors', () => {
  it('leaves text alone when the stream is not a terminal or has no colours', () => {
    expect(paint('pending', 'yellow', pipe)).toBe('pending');
    expect(paintLine('would adopt 002_notes (applied outside the runner; not re-run)', pipe))
      .toBe('would adopt 002_notes (applied outside the runner; not re-run)');
    const noColor = { isTTY: true, hasColors: () => false } as unknown as NodeJS.WriteStream;
    expect(paint('x', 'red', noColor)).toBe('x');
  });

  it('colours the status word and the dry-run verb, and nothing else changes', () => {
    const lines = [
      '  pending   003_add_notes',
      '  CHANGED   001_users   (edited after it was applied)',
      '  applied   000_create_schema_migrations',
      'would adopt 002_notes (applied outside the runner; not re-run)',
      'would apply 003_add_notes',
      'applied 2 file(s)',
      'something else',
    ];
    for (const line of lines) expect(plain(paintLine(line, tty))).toBe(line);

    expect(paintLine('  pending   003_add_notes', tty)).toBe('  \x1b[1m\x1b[33mpending\x1b[39m\x1b[22m   003_add_notes');
    expect(paintLine('would adopt 002_notes', tty)).toMatch(/^\x1b\[1m\x1b\[36mwould adopt\x1b\[39m\x1b\[22m 002_notes$/);
    expect(paintLine('  CHANGED   001_users   (edited)', tty)).toContain('\x1b[31mCHANGED');
    expect(paintLine('something else', tty)).toBe('something else');
  });
});
