// The example project's db-manager config. Run from this folder (after `npm run build` in the package):
//
//   cp .env.example .env
//   node ../dist/cli.js                 # the menu
//   node ../dist/cli.js migrate         # build the database; asks for the first administrator
//   node ../dist/cli.js status
//   node ../dist/cli.js export
//
// In a real project this is `npx db-manager ...` and the import below is the same.
import { scryptSync, randomBytes } from 'node:crypto';
import { defineConfig } from '@helix-x/db-manager';

/** scrypt, so the example needs no native module. A real app uses whatever its sign-in checks. */
const hash = (password) => {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 32).toString('hex')}`;
};

export default defineConfig({
  // Relative paths below start here (this file's folder).
  envFile: ['.env'],
  command: 'node ../dist/cli.js migrate',

  // DATABASE_TYPE, DATABASE_HOST, ... ; sqlite: DATABASE_FOLDER/example.sqlite
  connection: { env: { prefix: 'DATABASE_' } },
  sqlite: { baseDir: '.', fileName: 'example.sqlite' },

  migrations: { dir: 'database/migrations' },
  export: { dir: 'database/exports', fileName: '{name}_{YYYY}-{MM}-{DD}' },

  banner: {
    title: 'example database',
    rows: (env) => [['App env', env.APP_ENV ?? '']],
  },

  // A new database has no users: ask for the first administrator once, after the files.
  bootstrap: {
    label: 'first administrator',
    needed: (db) => db.isEmpty('users'),
    questions: [
      {
        name: 'email',
        message: 'Email',
        env: 'ADMIN_EMAIL',
        transform: (v) => v.trim().toLowerCase(),
        validate: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || `'${v}' is not an email address`,
      },
      {
        name: 'password',
        message: 'Password',
        type: 'password',
        env: 'ADMIN_PASSWORD',
        confirm: true,
        validate: (v) => v.length >= 10 || 'at least 10 characters',
      },
    ],
    describe: (a) => `would create administrator ${a.email}`,
    run: async (db, a) => {
      const [role] = await db.query(`SELECT id FROM roles WHERE name = ${db.param(1)}`, ['ADMIN']);
      if (!role) throw new Error('no ADMIN role: 001_create_users did not run');
      await db.query(
        `INSERT INTO users (email, password_hash, role_id) VALUES (${db.param(1)}, ${db.param(2)}, ${db.param(3)})`,
        [a.email, hash(a.password), role.id],
      );
      return `created administrator ${a.email}`;
    },
  },
});
