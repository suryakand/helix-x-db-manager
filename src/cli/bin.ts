import { createRequire } from 'node:module';
import { CliError } from './args';
import { paint } from './colors';
import { runCli } from './run';

/*
 * `db-manager`. Exit codes: 0 done, 1 refused or failed, 130 cancelled at a prompt (Ctrl+C).
 */

const readVersion = (): string => (createRequire(import.meta.url)('../package.json') as { version: string }).version;

runCli(process.argv.slice(2), readVersion).then(
  () => process.exit(0),
  (error: Error) => {
    // @inquirer/prompts rejects with ExitPromptError when the user presses Ctrl+C.
    if (error?.name === 'ExitPromptError') {
      console.error(`\n${paint('cancelled; nothing was changed', 'yellow', process.stderr)}`);
      process.exit(130);
    }
    const message = error instanceof CliError ? error.message : error?.message || String(error);
    console.error(`\n${paint('db-manager failed:', ['red', 'bold'], process.stderr)} ${message}\n`);
    process.exit(1);
  },
);
