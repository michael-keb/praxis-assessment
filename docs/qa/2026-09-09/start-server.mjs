import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Always use disposable data and explicit local credentials, regardless of
// the developer's shell settings. Regression runs never touch live data.
const dataDir = mkdtempSync(join(tmpdir(), 'praxis-experience-regression-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  ASSESSMENT_PORT: '18125',
  DATA_DIR: dataDir,
  ADMIN_EMAIL: 'qa@example.test',
  ADMIN_PASSWORD: 'qa-local-only',
  JWT_SECRET: 'qa-local-only',
  ASSEMBLYAI_API_KEY: '',
  EXTENSION_API_KEY: '',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit());
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }));
await import('../../../server/index.js');
