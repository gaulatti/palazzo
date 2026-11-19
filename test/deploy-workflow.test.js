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

// gaulatti/palazzo#45: the media relay binds 127.0.0.1 on an ephemeral port
// inside the container. No deploy path or Compose file publishes anything but
// the API and Icecast, and production never sets the local-only allowance.
test('deployments publish only the API and Icecast and never allow private media', async () => {
  const files = ['.github/workflows/deploy.yml', 'deploy/cumulus.sh', 'compose.yml'];
  for (const file of files) {
    const text = await readFile(join(process.cwd(), file), 'utf8');
    const published = [...text.matchAll(/(?:^|\s)(?:-p|--publish)\s+((?:\d+\.){3}\d+:.+?)\s*\\?$|^\s*-\s*"(127\.0\.0\.1:[^"]+)"/gm)].map((m) => (m[1] ?? m[2]).trim());
    assert.ok(published.length >= 2, `${file} lists its published ports`);
    for (const port of published) {
      assert.match(port, /:(3100|8000|\$\{ICECAST_PORT:-8000\})$/, `${file} publishes ${port}`);
    }
    if (file !== 'compose.yml') assert.doesNotMatch(text, /PALAZZO_MEDIA_ALLOW_PRIVATE/, file);
  }
});

test('the deploy log marks when the old instance stops and the new one is ready', async () => {
  const script = await readFile(join(process.cwd(), 'deploy', 'cumulus.sh'), 'utf8');
  const stop = script.indexOf('echo "PALAZZO_STOP');
  const ready = script.indexOf('echo "PALAZZO_READY');
  assert.ok(stop !== -1 && stop < script.indexOf('docker stop palazzo'));
  assert.ok(ready > script.indexOf('deployed_ready=true'));
});
