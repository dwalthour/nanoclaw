#!/usr/bin/env node
/**
 * Generate version info at build time.
 * Writes src/generated-version.ts with git SHA and build timestamp.
 */

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';

let gitSha = 'unknown';
let gitShaShort = 'unknown';

try {
  gitSha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  gitShaShort = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch {
  // Not in a git repo, or git not available
}

const buildTime = new Date().toISOString();

const content = `// Auto-generated at build time - do not commit
export const GIT_SHA = "${gitSha}";
export const GIT_SHA_SHORT = "${gitShaShort}";
export const BUILD_TIME = "${buildTime}";
`;

writeFileSync('src/generated-version.ts', content);
console.log(`Generated src/generated-version.ts: ${gitShaShort}`);