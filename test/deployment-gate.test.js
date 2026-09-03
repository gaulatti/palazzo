const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
const deployScript = readFileSync('deploy/cumulus.sh', 'utf8');
const nginx = readFileSync('deploy/cumulus.nginx.conf', 'utf8');

test('preserves the on-premises gate and adds the fail-closed Cumulus path', () => {
  assert.equal(
    workflow.match(/uses: actions\/checkout@v4/g)?.length,
    2,
    'the independent deploy job must check out its deployment definitions',
  );
  assert.match(workflow, /if: vars\.ON_PREMISES == 'true'/);
  assert.match(workflow, /if: vars\.ON_PREMISES != 'true'/);
  assert.match(workflow, /role\/palazzo-github-deploy/);
  assert.match(workflow, /Name=tag:Name,Values=macondo-services/);
  assert.match(workflow, /Expected exactly one running Macondo service host/);
  assert.match(workflow, /broadcast\/production\/config/);
  assert.match(workflow, /broadcast\/production\/icecast-source-password/);
  assert.doesNotMatch(workflow, /MacondoStack/);
  assert.doesNotMatch(workflow, /route53 change-resource-record-sets/);
  assert.match(workflow, /deploy\/cumulus\.sh/);
  assert.match(workflow, /deploy\/cumulus\.nginx\.conf/);
  assert.match(workflow, /deployment_status=0/);
  assert.match(workflow, /exit \$deployment_status/);
  assert.match(workflow, /InvocationDoesNotExist/);
  assert.match(workflow, /sleep 5\s+continue/);
});

test('publishes the Modo Italiano listener through the Palazzo stream', () => {
  assert.match(nginx, /server_name radio\.modoitaliano\.fm/);
  assert.match(nginx, /return 302 \/stream/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8000/);
  assert.match(nginx, /add_header Access-Control-Allow-Origin "\*" always/);
  assert.match(deployScript, /certbot .* -d radio\.modoitaliano\.fm/);
  assert.match(deployScript, /https:\/\/radio\.modoitaliano\.fm\/stream/);
});
