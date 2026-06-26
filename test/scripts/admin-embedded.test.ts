import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');

describe('admin embedded asset guards', () => {
  test('admin embedded generator is deterministic across calendar days', () => {
    const generator = readFileSync(join(repoRoot, 'scripts/build-admin-embedded.ts'), 'utf8');
    const embedded = readFileSync(join(repoRoot, 'src/admin-embedded.ts'), 'utf8');

    expect(generator).not.toContain('new Date()');
    expect(embedded).not.toMatch(/Source: admin\/dist\/ at \d{4}-\d{2}-\d{2}/);
  });

  test('admin embedded freshness checks compare generated content to the worktree file, not the git index', () => {
    const checkAdminBuild = readFileSync(join(repoRoot, 'scripts/check-admin-build.sh'), 'utf8');
    const checkAdminEmbedded = readFileSync(join(repoRoot, 'scripts/check-admin-embedded.sh'), 'utf8');

    for (const script of [checkAdminBuild, checkAdminEmbedded]) {
      expect(script).toContain('build-admin-embedded.ts');
      expect(script).toContain('sha256sum');
      expect(script).not.toContain('git diff --exit-code -- src/admin-embedded.ts');
    }
  });
});
