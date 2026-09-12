const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const deployScript = readFileSync('deploy/cumulus.sh', 'utf8');
const compose = readFileSync('compose.yml', 'utf8');
const nginx = readFileSync('deploy/cumulus.nginx.conf', 'utf8');

const assertBoundedLocalLogging = (definition, expectedContainers) => {
  assert.equal(
    definition.match(/--log-driver=local/g)?.length,
    expectedContainers,
  );
  assert.equal(
    definition.match(/--log-opt max-size=10m/g)?.length,
    expectedContainers,
  );
  assert.equal(
    definition.match(/--log-opt max-file=3/g)?.length,
    expectedContainers,
  );
  assert.doesNotMatch(definition, /awslogs|\/services\/palazzo/);
};

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
  assert.match(workflow, /broadcast\/production\/icecast-source-password/);
  assert.doesNotMatch(workflow, /palazzo-control-token|PALAZZO_CONTROL_TOKEN/);
  assert.doesNotMatch(deployScript, /palazzoControlToken|PALAZZO_CONTROL_TOKEN/);
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

test('keeps every deployment container log local and bounded', () => {
  assertBoundedLocalLogging(workflow, 2);
  assertBoundedLocalLogging(deployScript, 2);
  assertBoundedLocalLogging(ciWorkflow, 1);
  assert.match(compose, /logging:\s+driver: local/);
  assert.match(compose, /max-size: "10m"/);
  assert.match(compose, /max-file: "3"/);
  assert.doesNotMatch(compose, /awslogs|\/services\/palazzo/);
  assert.match(ciWorkflow, /HostConfig\.LogConfig\.Type == "local"/);
  assert.match(ciWorkflow, /"max-file":"3","max-size":"10m"/);

  assert.match(workflow, /docker logs --tail 200 palazzo-candidate/);
  assert.match(workflow, /docker logs --tail 200 palazzo/);
  assert.match(deployScript, /docker logs --tail 200 palazzo-candidate/);
  assert.match(deployScript, /docker logs --tail 200 palazzo/);
});
