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
  const fillerVolume = workflow.indexOf(
    'docker volume create palazzo-fillers >/dev/null',
  );
  const replacement = workflow.indexOf('docker stop palazzo');

  assert.notEqual(failFast, -1);
  assert.ok(failFast < network);
  assert.ok(network < fillerVolume);
  assert.ok(fillerVolume < replacement);
});

test('deployment verifies a candidate and retains a rollback container', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /--name palazzo-candidate/);
  assert.match(workflow, /transport not ready/);
  assert.match(workflow, /docker rename palazzo palazzo-rollback/);
  assert.match(workflow, /rolling back/);
  assert.match(workflow, /palazzo:\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /--build-arg BUILD_VERSION=\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /control-token|PALAZZO_CONTROL_TOKEN/);
  assert.match(workflow, /palazzo-fillers:\/var\/lib\/palazzo\/fillers/);
  assert.doesNotMatch(workflow, /\/opt\/palazzo/);
});
