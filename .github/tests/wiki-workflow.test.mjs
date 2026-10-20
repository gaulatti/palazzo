import assert from 'node:assert/strict';
import {cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {parse} from 'yaml';
import {allowed} from './workflow-expressions.mjs';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const workflow = parse(readFileSync(join(root, '.github/workflows/wiki.yml'), 'utf8'));
const config = JSON.parse(readFileSync(join(root, '.github/clouseau-wiki.json'), 'utf8'));
const {resolveDeployment} = require('../scripts/wiki-deployment.cjs');
const {validateConfig} = require(join(root, '.clouseau-ci/src/wiki.cjs'));
const {snapshot, prepareWiki, publishWiki} = require(join(root, '.clouseau-ci/src/wiki-git.cjs'));

function boundary() {
  const context = Object.assign(Object.create({get repo() {return {owner: 'gaulatti', repo: 'palazzo'};}}), {ref: 'refs/heads/main',
    actor: 'gaulatti', eventName: 'workflow_run', sha: 'b'.repeat(40), runId: 900});
  const run = {id: 42, repository: {full_name: 'gaulatti/palazzo'}, head_repository: {full_name: 'gaulatti/palazzo'},
    path: '.github/workflows/deploy.yml', head_branch: 'main', head_sha: 'a'.repeat(40),
    event: 'workflow_dispatch', status: 'completed', conclusion: 'success'};
  const state = {context, run, latest: 42, calls: 0};
  state.github = {rest: {actions: {
    getWorkflowRun: async args => {state.calls++; assert.equal(args.run_id, 42); return {data: run};},
    listWorkflowRuns: async args => {assert.equal(args.workflow_id, 'deploy.yml'); assert.equal(args.status, 'success');
      return {data: {workflow_runs: state.latest ? [{id: state.latest}] : []}};},
  }}};
  return state;
}

test('the real resolver binds docs to the successful deployment rather than the documentation runner', async () => {
  const f = boundary();
  const selected = await resolveDeployment({...f, config, runId: '42'});
  assert.deepEqual(selected.repo, f.context.repo, 'GitHub Context exposes repo through a prototype getter');
  assert.equal(selected.sha, f.run.head_sha); assert.equal(selected.runId, 42);
  assert.notEqual(selected.sha, f.context.sha); assert.notEqual(selected.runId, f.context.runId);
  for (const event of ['push', 'workflow_dispatch']) {
    f.run.event = event; f.context.eventName = 'workflow_dispatch';
    assert.equal((await resolveDeployment({...f, config, runId: 42})).runId, 42);
  }
});

test('foreign, failed, stale and untrusted deployment selections fail before a model or publisher can run', async () => {
  for (const mutate of [
    f => {f.context.ref = 'refs/heads/topic';}, f => {f.context.eventName = 'pull_request';},
    f => {f.context.eventName = 'workflow_dispatch'; f.context.actor = 'contributor';},
    f => {f.run.repository.full_name = 'external/fork';}, f => {f.run.head_repository = null;},
    f => {f.run.path = '.github/workflows/ci.yml';}, f => {f.run.head_branch = 'topic';},
    f => {f.run.event = 'pull_request';}, f => {f.run.head_sha = 'invalid';},
    f => {f.run.status = 'in_progress';}, f => {f.run.conclusion = 'failure';},
    f => {f.run.conclusion = 'cancelled';}, f => {f.run.conclusion = 'skipped';},
    f => {f.latest = 43;}, f => {f.latest = null;},
  ]) {
    const f = boundary(); mutate(f); let providerOrPublisher = 0;
    await assert.rejects(async () => {await resolveDeployment({...f, config, runId: 42}); providerOrPublisher++;}, /require|newer/i);
    assert.equal(providerOrPublisher, 0);
  }
  for (const runId of ['', '0', '-1', '42; echo unsafe', '9'.repeat(30)]) {
    const f = boundary(); await assert.rejects(resolveDeployment({...f, config, runId}), /require/); assert.equal(f.calls, 0);
  }
});

test('actual workflow expressions reject unsuccessful deployment events and failed planning', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['workflow_dispatch', 'workflow_run']);
  assert.deepEqual(workflow.on.workflow_run, {workflows: ['Deploy'], types: ['completed'], branches: ['main']});
  for (const conclusion of ['success', 'failure', 'cancelled', 'skipped']) {
    const c = {github: {ref: 'refs/heads/main', event_name: 'workflow_run', event: {workflow_run: {conclusion}}}};
    assert.equal(allowed(workflow.jobs.plan.if, c), conclusion === 'success');
  }
  for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
    const c = {github: {ref: 'refs/heads/main'}, needs: {plan: {result}}};
    assert.equal(allowed(workflow.jobs.publish.if, c, {success: result === 'success'}), result === 'success');
  }
});

test('generation and publication isolate credentials and use only their own plan artifact and pinned code', () => {
  validateConfig(config);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.plan.permissions, {contents: 'read', actions: 'read'});
  assert.deepEqual(workflow.jobs.publish.permissions, {contents: 'write', actions: 'read'});
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const text = JSON.stringify(job);
    assert.ok(!text.includes('DEPLOYMENT_TOKEN') && !text.includes('id-token') && !text.includes('aws '));
    if (name === 'publish') assert.ok(!text.includes('DEEPSEEK_API_KEY'));
    const checkouts = job.steps.filter(s => s.uses?.startsWith('actions/checkout@'));
    assert.equal(checkouts[0].with.ref, '${{ github.sha }}');
    const deployed = checkouts.find(s => s.with.path === 'deployed-source');
    assert.equal(deployed.with.ref, '${{ steps.deployment.outputs.sha }}');
    for (const checkout of checkouts) assert.equal(checkout.with['persist-credentials'], name === 'publish' && checkout.with.path === 'wiki');
    const engine = checkouts.find(s => s.with.repository === 'gaulatti/clouseau');
    assert.match(engine.with.ref, /^[a-f0-9]{40}$/);
  }
  const upload = workflow.jobs.plan.steps.find(s => s.uses?.startsWith('actions/upload-artifact@'));
  const download = workflow.jobs.publish.steps.find(s => s.uses?.startsWith('actions/download-artifact@'));
  assert.equal(upload.with.name, download.with.name);
  assert.match(upload.with.name, /github.run_id.*github.run_attempt/);
  const publish = workflow.jobs.publish.steps.at(-1).with.script;
  assert.ok(publish.indexOf('resolveDeployment') < publish.indexOf('publishWiki'));
  assert.ok(!JSON.stringify(workflow).includes('createWorkflowDispatch'));
});

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'palazzo-wiki-contract-'));
  t.after(() => rmSync(temp, {recursive: true, force: true}));
  const sourceDirectory = join(temp, 'source');
  const wikiDirectory = join(temp, 'wiki');
  const remote = join(temp, 'wiki.git');
  const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']}).trim();
  mkdirSync(sourceDirectory);
  for (const prefix of config.source_paths) {
    const destination = join(sourceDirectory, prefix);
    mkdirSync(dirname(destination), {recursive: true});
    cpSync(join(root, prefix), destination, {recursive: true});
  }
  const init = dir => {
    git(dir, ['init', '-q', '-b', 'master']);
    git(dir, ['config', 'user.name', 'Palazzo wiki fixture']);
    git(dir, ['config', 'user.email', 'fixture@example.test']);
  };
  init(sourceDirectory);
  git(sourceDirectory, ['add', '.']); git(sourceDirectory, ['commit', '-qm', 'fixture: snapshot actual public documentation sources']);
  mkdirSync(remote); git(remote, ['init', '--bare', '-q']);
  mkdirSync(wikiDirectory); init(wikiDirectory);
  writeFileSync(join(wikiDirectory, 'Home.md'), '# Palazzo\n[Deployment](Deployment)\n');
  writeFileSync(join(wikiDirectory, 'Deployment.md'), '# Deployment\nExisting operator notes.\n');
  git(wikiDirectory, ['add', '.']); git(wikiDirectory, ['commit', '-qm', 'fixture: initial wiki']);
  git(wikiDirectory, ['remote', 'add', 'origin', remote]); git(wikiDirectory, ['push', '-qu', 'origin', 'HEAD:master']);
  const context = {repo: {owner: 'gaulatti', repo: 'palazzo'}, sha: git(sourceDirectory, ['rev-parse', 'HEAD']), runId: 42};
  const f = {git, remote, sourceDirectory, wikiDirectory, context, config, deployment: 'success', requests: 0};
  const method = Object.assign(async () => ({data: [{name: 'deploy', status: 'completed', conclusion: f.deployment}]}), {kind: 'jobs'});
  f.github = {rest: {actions: {getWorkflowRun: async () => ({data: {head_sha: f.context.sha, head_branch: 'main', path: '.github/workflows/deploy.yml'}}), listJobsForWorkflowRun: method}},
    paginate: async (endpoint, args) => {assert.equal(args.run_id, f.context.runId); return (await endpoint()).data;}};
  const source = snapshot({...f, repository: 'gaulatti/palazzo', revision: context.sha, runId: context.runId}).source;
  assert.equal(source['.github/scripts/wiki-deployment.cjs'], readFileSync(join(root, '.github/scripts/wiki-deployment.cjs'), 'utf8'), 'factual review receives the exact deployed deployment guard');
  const sourceId = '.github/workflows/deploy.yml:L1';
  f.complete = async ({messages}) => {
    f.requests += 1;
    const input = JSON.parse(messages[1].content);
    if (input.proposed_update) return {content: JSON.stringify({pages: {[input.proposed_update[0].path]: {source_id: sourceId, findings: '', supported: true}}})};
    if (input.requested_page) return {content: JSON.stringify({path: input.requested_page, content: input.requested_page === 'Home.md' ? '# Palazzo\n[Deployment](Deployment)\nDocumentation follows the deployed source.\n' : '# Deployment\nDocumentation follows a successful deployment.\n'})};
    return {content: JSON.stringify({pages: [{path: 'Home.md', reason: 'Keep navigation coordinated.'}, {path: 'Deployment.md', reason: 'Explain the deployed documentation workflow.'}]})};
  };
  return f;
}

test('the real pinned engine blocks model requests before unsuccessful deployment and publishes coordinated pages in one Git commit', async t => {
  const f = fixture(t);
  for (const state of ['failure', 'cancelled', 'skipped']) {
    f.deployment = state;
    await assert.rejects(prepareWiki(f), /successful deployment/);
    assert.equal(f.requests, 0);
  }
  f.deployment = 'success';
  const before = f.git(f.remote, ['rev-parse', 'master']);
  const bundle = await prepareWiki(f);
  assert.equal(f.requests, 5, 'one plan, two page generations and two factual reviews through the provider boundary');
  assert.equal(bundle.source_sha, f.context.sha);
  assert.equal(bundle.deployment_run_id, 42);
  assert.equal(bundle.updates.length, 2);
  f.deployment = 'failure';
  await assert.rejects(publishWiki({...f, bundle}), /successful deployment/);
  assert.equal(f.git(f.remote, ['rev-parse', 'master']), before);
  f.deployment = 'success';
  const published = await publishWiki({...f, bundle});
  assert.equal(published.changedPages, 2);
  assert.equal(f.git(f.remote, ['rev-list', '--count', `${before}..master`]), '1');
  assert.equal(f.git(f.remote, ['show', 'master:Deployment.md']), '# Deployment\nDocumentation follows a successful deployment.');
  const receipt = JSON.parse(f.git(f.remote, ['show', 'master:.clouseau-deployment.json']));
  assert.equal(receipt.source_sha, f.context.sha); assert.equal(receipt.deployment_run_id, 42);
  f.git(f.wikiDirectory, ['checkout', '--detach', published.commit]);
  f.context.runId = 43;
  const repeated = await prepareWiki(f);
  assert.equal(repeated.updates.length, 0); assert.equal(f.requests, 5, 'an already documented revision makes no further model request');
  assert.equal((await publishWiki({...f, bundle: repeated})).alreadyDocumented, true);
  writeFileSync(join(f.wikiDirectory, 'Home.md'), '# Palazzo\nA concurrent human edit.\n');
  f.git(f.wikiDirectory, ['add', 'Home.md']); f.git(f.wikiDirectory, ['commit', '-qm', 'fixture: concurrent human edit']);
  f.git(f.wikiDirectory, ['push', 'origin', 'HEAD:master']);
  const human = f.git(f.remote, ['rev-parse', 'master']);
  await assert.rejects(publishWiki({...f, bundle: repeated}), /Wiki changed/);
  assert.equal(f.git(f.remote, ['rev-parse', 'master']), human, 'publication cannot overwrite a concurrent human edit');
});
