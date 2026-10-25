import { confirm, input, password, select } from '@inquirer/prompts';
import type { ImportPlan } from '../engine/db-import';
import type { BootstrapConfig, Env } from '../config/types';
import { CliError } from './args';

/*
 * Every question the CLI asks, on @inquirer/prompts. Nothing here runs off a terminal: callers check
 * interactive() first and refuse with a message naming the flag or variable to use instead.
 */

/** Whether there is a person to ask. */
export const interactive = (): boolean => !!process.stdin.isTTY;

/** A dragged-in path arrives quoted or with escaped spaces; take it either way. */
export function cleanPath(value: string): string {
  const t = value.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
  return t.replace(/\\ /g, ' ');
}

/** A y/N question; No by default. */
export function askYesNo(message: string): Promise<boolean> {
  return confirm({ message, default: false });
}

/** A line of text. */
export function askText(message: string, options: { default?: string; validate?: (value: string) => true | string } = {}): Promise<string> {
  return input({ message, default: options.default, validate: options.validate });
}

/** One of several choices. */
export function askChoice<T>(message: string, choices: Array<{ name: string; value: T; description?: string }>, pageSize = 12): Promise<T> {
  return select({ message, choices, pageSize });
}

/**
 * The last word before an import writes. With rows to delete it lists them and, in `name` mode, wants
 * the database name typed back -- a y/N is too easy to give by reflex when the answer deletes data.
 */
export async function confirmImport(plan: ImportPlan, name: string, target: string, mode: 'name' | 'yes'): Promise<boolean> {
  // Quotes and spaces around the answer are noise, not a different name.
  const answer = async (message: string): Promise<string> => (await input({ message })).replace(/^(['"])(.*)\1$/, '$2').trim();
  const deleting = plan.tables.filter((t) => t.targetRows > 0);
  if (deleting.length === 0) return askYesNo(`Import into ${target}?`);
  const total = deleting.reduce((n, t) => n + t.targetRows, 0);
  console.warn(`\nWARNING: this REPLACES the data in ${target}. These tables are emptied, then reloaded from the dump:`);
  for (const t of deleting) console.warn(`  ${t.name.padEnd(40)} ${String(t.targetRows).padStart(9)} row(s) deleted`);
  console.warn(`  ${total} row(s) in all. There is no backup step: export first if you need them.\n`);
  if (mode === 'yes') return askYesNo(`Replace the data in ${target}?`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const reply = await answer(`Type the database name -- ${name} -- to replace its data (empty answer cancels):`);
    if (reply === name) return true;
    if (!reply) return false;
    // y/yes is the reflex this question exists to stop; say so rather than cancelling silently.
    console.warn(/^y(es)?$/i.test(reply)
      ? `  '${reply}' is not enough here: type the database name itself, ${name}.`
      : `  '${reply}' is not '${name}'.${attempt < 3 ? ' Try again.' : ''}`);
  }
  return false;
}

/**
 * The bootstrap step's answers: from its environment variables where set, else asked on the terminal.
 *
 * @throws CliError when an answer is missing and there is no terminal, an answer is refused, or a confirmation differs.
 */
export async function bootstrapAnswers(bootstrap: BootstrapConfig, env: Env): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  const toAsk = bootstrap.questions.filter((q) => !(q.env && env[q.env]));
  if (toAsk.length && !interactive()) {
    const vars = toAsk.map((q) => q.env).filter(Boolean);
    throw new CliError(
      `this database needs its ${bootstrap.label}, and there is no terminal to ask on.` +
        (vars.length === toAsk.length ? ` Set ${vars.join(' and ')}.` : ''),
    );
  }
  if (toAsk.length) console.log(`This database has no ${bootstrap.label} yet. Create it:`);
  for (const q of bootstrap.questions) {
    const tidy = (v: string): string => (q.transform ? q.transform(v) : v);
    const fromEnv = q.env ? env[q.env] : undefined;
    let value: string;
    if (fromEnv) {
      value = tidy(fromEnv);
      const ok = q.validate ? q.validate(value) : true;
      if (ok !== true) throw new CliError(`${q.env}: ${ok}`);
    } else {
      const validate = (v: string): true | string => (q.validate ? q.validate(tidy(v)) : true);
      const ask = (message: string): Promise<string> =>
        q.type === 'password' ? password({ message, mask: '*', validate }) : input({ message, validate });
      value = await ask(q.message);
      if (q.confirm && (await ask(`${q.message} (again)`)) !== value) throw new CliError('the answers do not match; nothing was changed');
      value = tidy(value);
    }
    answers[q.name] = value;
  }
  return answers;
}
