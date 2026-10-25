import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConnectionSpec } from '../config/types';
import { assertPlainSql } from '../engine/db-import';
import { migrationFiles } from '../engine/schema-migrate';
import type { EngineSettings } from '../engine/settings';
import type { CliOptions } from './args';
import { askChoice, askText, askYesNo, cleanPath } from './prompts';
import { shortPath } from './banner';

type MenuChoice = 'status' | 'dry-run' | 'apply' | 'baseline' | 'init' | 'export' | 'import-dry-run' | 'import' | 'quit';

/**
 * No command on a terminal: asks what to do, and fills in what that needs (a baseline prefix, an
 * export folder, a dump file). Returns false for Quit.
 */
export async function chooseFromMenu(
  opts: CliOptions,
  ctx: { spec: ConnectionSpec; migrationsDir: string; exportDir: string; settings: EngineSettings },
): Promise<boolean> {
  const choice = await askChoice<MenuChoice>('What do you want to do?', [
    { name: 'Status', value: 'status', description: 'Every migration file and what the ledger says about it. Read only.' },
    { name: 'Migrate: dry run', value: 'dry-run', description: 'List the files that would be applied. Writes nothing.' },
    { name: 'Migrate: apply pending files', value: 'apply', description: 'Apply every pending file; a new database is built from the first one.' },
    { name: 'Baseline', value: 'baseline', description: 'Record the files a database already has, without running them.' },
    { name: 'Init', value: 'init', description: 'Create the ledger table in a database that predates it.' },
    { name: 'Export', value: 'export', description: 'Write the whole database to one plain SQL file.' },
    { name: 'Import: dry run', value: 'import-dry-run', description: 'Check a dump against this database and load it inside a rolled-back transaction.' },
    { name: 'Import', value: 'import', description: "Load a dump, replacing this database's data." },
    { name: 'Quit', value: 'quit' },
  ]);
  switch (choice) {
    case 'quit':
      return false;
    case 'status':
    case 'init':
    case 'apply':
      opts.action = choice;
      return true;
    case 'dry-run':
      opts.action = 'apply';
      opts.dryRun = true;
      return true;
    case 'baseline': {
      opts.action = 'baseline';
      const files = migrationFiles(ctx.migrationsDir, ctx.spec.type, ctx.settings);
      opts.baselinePrefix = await askChoice(
        'The last file this database already has (it and every file before it are recorded, not run):',
        files.map((f) => ({ name: f.version, value: f.version })).reverse(),
      );
      opts.dryRun = await askYesNo('Dry run first (list what would be recorded)?');
      return true;
    }
    case 'export': {
      opts.action = 'export';
      opts.out = resolve(process.cwd(), cleanPath(await askText('Folder to write the export to:', { default: shortPath(ctx.exportDir) })));
      if (ctx.spec.type === 'postgres') {
        opts.columnInserts = await askYesNo('Write rows as INSERT statements instead of COPY blocks (bigger, easier to edit)?');
      }
      return true;
    }
    case 'import-dry-run':
    case 'import': {
      opts.action = 'import';
      opts.dryRun = choice === 'import-dry-run';
      opts.importFile = cleanPath(await askText('Dump file path:', {
        validate: (value) => {
          const file = resolve(process.cwd(), cleanPath(value));
          if (!value.trim()) return 'a file is needed';
          if (!existsSync(file)) return `no file at ${file}`;
          try {
            assertPlainSql(file);
            return true;
          } catch (error) {
            return (error as Error).message;
          }
        },
      }));
      return true;
    }
  }
}
