/** A refusal or bad input: printed as a message, never with a stack. */
export class CliError extends Error {}

/** What the command was asked to do. `menu` asks. */
export type CliAction = 'menu' | 'status' | 'apply' | 'init' | 'baseline' | 'export' | 'import';

/** The parsed command line. */
export interface CliOptions {
  action: CliAction;
  /** import's file; null means ask. */
  importFile: string | null;
  /** export's folder. */
  out: string | null;
  /** export, postgres: pg_dump writes INSERTs with column lists instead of COPY. */
  columnInserts: boolean;
  dryRun: boolean;
  baselinePrefix: string;
  envFile: string | null;
  dir: string | null;
  config: string | null;
  yes: boolean;
  force: boolean;
  help: boolean;
  version: boolean;
}

export const USAGE = `Usage: db-manager [command] [options]

Commands (no command on a terminal opens a menu):
  status                    every migration file and the ledger; read only
  migrate                   apply the pending files (alias: apply)
  init                      create the ledger table
  baseline <prefix>         record files up to the last one starting with <prefix>, without running them
  export                    write the whole database to one plain SQL file
  import [file]             load a plain SQL dump, replacing the data (asks for the file when not given)

Options:
  --dry-run                 say what would happen; with import, load the dump and roll back
  --out <dir>               export: where to write
  --column-inserts          export, postgres: rows as INSERTs with column lists instead of COPY
  --config <file>           the config file (default: db-manager.config.* found from here up)
  --env-file <file>         read this env file instead of the configured ones
  --dir <path>              the migrations directory
  --yes, -y                 do not ask; required when there is no terminal
  --force                   apply even though the ledger has no rows
  --init, --baseline <p>, --export, --import [file]
                            the commands, as flags. The last command or flag given wins
  --help, -h                this text
  --version                 the package version`;

const COMMANDS: Record<string, CliAction> = {
  status: 'status', migrate: 'apply', apply: 'apply', init: 'init', baseline: 'baseline', export: 'export', import: 'import', menu: 'menu',
};

/**
 * Reads the arguments. Command words and the command flags all set the action; the last one
 * given wins, so `migrate --baseline 006` baselines and `migrate status` reports. That lets an npm
 * script fix `migrate` and still be redirected (`npm run db:migrate -- status`).
 *
 * @throws CliError for an unknown argument or a missing value.
 */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    action: 'menu', importFile: null, out: null, columnInserts: false, dryRun: false, baselinePrefix: '',
    envFile: null, dir: null, config: null, yes: false, force: false, help: false, version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new CliError(`${arg} needs a value`);
      return v;
    };
    /** The optional value after an argument: the next word, unless it is a flag. */
    const optional = (): string | null => (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : null);

    if (!arg.startsWith('-') && COMMANDS[arg]) {
      opts.action = COMMANDS[arg];
      if (arg === 'baseline') opts.baselinePrefix = value();
      if (arg === 'import') opts.importFile = optional();
    }
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--init') opts.action = 'init';
    else if (arg === '--baseline') { opts.action = 'baseline'; opts.baselinePrefix = value(); }
    else if (arg === '--export') opts.action = 'export';
    else if (arg === '--import') { opts.action = 'import'; opts.importFile = optional() ?? opts.importFile; }
    else if (arg === '--out') opts.out = value();
    else if (arg === '--column-inserts') opts.columnInserts = true;
    else if (arg === '--config') opts.config = value();
    else if (arg === '--env-file') opts.envFile = value();
    else if (arg === '--dir') opts.dir = value();
    else if (arg === '--yes' || arg === '-y') opts.yes = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--version') opts.version = true;
    else throw new CliError(`unknown argument: ${arg}\n\n${USAGE}`);
  }
  // Import reads COPY and INSERT dumps alike, so the flag only means something to export.
  if (opts.columnInserts && opts.action !== 'export') throw new CliError('--column-inserts goes with export (import reads either kind of dump)');
  if (opts.out && opts.action !== 'export') throw new CliError('--out goes with export');
  return opts;
}
