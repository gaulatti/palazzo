import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {parse} from 'yaml';

test('the real pinned coverage action accepts the application report and rejects an uncovered production branch', t => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const engine = join(root, '.clouseau-ci');
  const workflow = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const action = parse(readFileSync(join(engine, 'action.yml'), 'utf8'));
  const invocation = workflow.jobs.verify.steps.find(step => step.with?.operation === 'coverage');
  const implementation = action.runs.steps.find(step => step.name === 'Enforce 100% line and branch coverage');
  assert.ok(action.inputs['coverage-format'], 'the pinned action must support this consumer’s actual native report format');
  const directory = mkdtempSync(join(tmpdir(), 'palazzo-coverage-consumer-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const invoke = report => spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', implementation.run], {
    cwd: root, encoding: 'utf8', env: {...process.env, CLOUSEAU_ROOT: engine,
      COVERAGE_REPORT: report, SOURCE_DIRECTORY: invocation.with['source-directory'], COVERAGE_FORMAT: invocation.with['coverage-format']}});
  const reportPath = join(root, invocation.with['coverage-report']);
  const passed = invoke(reportPath);
  assert.equal(passed.status, 0, passed.stderr);
  for (const metric of ['lines', 'branches']) {
    const counts = passed.stdout.match(new RegExp(`${metric}: ([0-9]+)/([0-9]+)`));
    assert.ok(counts, passed.stdout); assert.ok(Number(counts[1]) > 0); assert.equal(counts[1], counts[2]);
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const entry = Object.values(report).find(item => Object.keys(item.b).length > 0);
  assert.ok(entry, 'the actual application must contain measured branches');
  entry.b[Object.keys(entry.b)[0]][0] = 0;
  const uncovered = join(directory, 'uncovered.json'); writeFileSync(uncovered, JSON.stringify(report));
  const rejected = invoke(uncovered);
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /Coverage gate failed/);
  assert.notEqual(readFileSync(reportPath, 'utf8'), readFileSync(uncovered, 'utf8'), 'the native report is preserved unchanged');
});
