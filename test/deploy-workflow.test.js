const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const test = require('node:test');

const workflowPath = join(process.cwd(), '.github', 'workflows', 'deploy.yml');

test('deployment fails before replacing production when prerequisites are absent', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const failFast = workflow.indexOf('set -eu');
  const network = workflow.indexOf(
    'docker network inspect broadcast-control >/dev/null',
  );
  const token = workflow.indexOf('test -s /etc/palazzo/control-token');
  const replacement = workflow.indexOf('docker stop palazzo');

  assert.notEqual(failFast, -1);
  assert.ok(failFast < network);
  assert.ok(failFast < token);
  assert.ok(token < replacement);
  assert.ok(network < replacement);
});

test('deployment verifies a candidate and retains a rollback container', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /--name palazzo-candidate/);
  assert.match(workflow, /transport not ready/);
  assert.match(workflow, /docker rename palazzo palazzo-rollback/);
  assert.match(workflow, /rolling back/);
  assert.match(workflow, /palazzo:\$\{\{ github\.sha \}\}/);
  assert.equal(
    workflow.match(/\/etc\/palazzo\/control-token:\/run\/secrets\/palazzo-control-token:ro/g).length,
    2,
  );
  assert.match(workflow, /\/opt\/palazzo\/fillers:\/var\/lib\/palazzo\/fillers/);
});
