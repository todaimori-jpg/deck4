/**
 * Syntax gate: parses every module in src/ as an ES module and reports the
 * first error per file. Cheap enough to run after every edit.
 *
 *   ELECTRON_RUN_AS_NODE=1 Qoder.exe tools/check.mjs
 */
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else if (extname(entry.name) === '.js' || extname(entry.name) === '.mjs') out.push(p);
  }
  return out;
}

const target = process.argv[2] || 'src';
const files = await walk(target);
const scratch = await mkdtempSafe();
let failed = 0;

for (const file of files) {
  const copy = join(scratch, file.replaceAll(/[\\/]/g, '_') + '.mjs');
  await writeFile(copy, await readFile(file));
  try {
    execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
    console.log(`ok   ${file}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${file}`);
    console.log(String(err.stderr || err.message).replace(new RegExp(scratch, 'g'), file));
  }
}

await rm(scratch, { recursive: true, force: true });
console.log(failed ? `\n${failed} file(s) failed` : `\n${files.length} files parse cleanly`);
process.exit(failed ? 1 : 0);

async function mkdtempSafe() {
  const dir = join(tmpdir(), `qoder-check-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
