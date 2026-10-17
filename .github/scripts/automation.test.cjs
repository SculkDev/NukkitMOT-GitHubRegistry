'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const checkUpstream = require('./check-upstream.cjs');
const publishRelease = require('./publish-release.cjs');
const findRelease = require('./find-release.cjs');

const digest = `sha256:${'a'.repeat(64)}`;
const context = {
  repo: {owner: 'SculkDev', repo: 'NukkitMOT-GitHubRegistry'},
  sha: 'b'.repeat(40), serverUrl: 'https://github.com', runId: 123,
};
const missing = () => Object.assign(new Error('Not found'), {status: 404});
const readyImage = () => ({digest, images: [
  {os: 'linux', architecture: 'amd64'}, {os: 'linux', architecture: 'arm64'},
]});

function detection(overrides = {}) {
  const outputs = {};
  const options = {
    context, channel: 'stable',
    core: {info() {}, setOutput(key, value) { outputs[key] = value; }},
    github: {rest: {repos: {
      async getReleaseByTag() { throw missing(); },
      async listReleases() { return {data: []}; },
    }}},
    async readJson(url) {
      if (url.includes('?')) return {results: [{name: '1.26.50-R1'}], next: null};
      return readyImage();
    },
    ...overrides,
  };
  return {options, outputs};
}

test('stable discovery compares numeric versions, ignores Java variants, and follows pagination', async () => {
  let calls = 0;
  const tag = await checkUpstream.findTag('stable', async () => {
    calls++;
    return calls === 1
      ? {results: ['1.26.9-R1', '1.26.50-R1-java25', 'latest'].map(name => ({name})),
        next: 'https://hub.docker.com/v2/repositories/memoriesoftime/nukkit-mot/tags?page=2'}
      : {results: ['1.26.50-R1', '1.26.50-R2', '1.26.50-R2.1'].map(name => ({name})), next: null};
  });
  assert.equal(tag, '1.26.50-R2.1');
  assert.equal(calls, 2);
});

test('stable discovery refuses foreign pagination URLs', async () => {
  await assert.rejects(checkUpstream.findTag('stable', async () => ({results: [], next: 'https://example.org/'})), /pagination/);
});

test('no stable release is an error, never a silent fallback to snapshots', async () => {
  await assert.rejects(checkUpstream.findTag('stable', async () => ({results: [], next: null})), /no stable/);
});

test('an explicit tag can track snapshots; invalid tags cannot reach Docker or shell arguments', async () => {
  assert.equal(await checkUpstream.findTag('latest', () => assert.fail('Unexpected fetch')), 'latest');
  await assert.rejects(checkUpstream.findTag('latest\nINJECT=value', () => {}), /valid Docker tag/);
});

test('a new image creates a digest-pinned plan and lower-case GHCR tags', async () => {
  const {options, outputs} = detection();
  await checkUpstream(options);
  assert.equal(outputs.build, 'true');
  assert.equal(outputs.base_image, `memoriesoftime/nukkit-mot:1.26.50-R1@${digest}`);
  const plan = JSON.parse(outputs.plan);
  assert.equal(plan.image, 'ghcr.io/sculkdev/nukkitmot-githubregistry');
  assert.equal(plan.tags.length, 3);
  assert.equal(plan.tags[0], `${plan.image}:latest`);
  assert.match(plan.immutableTag, /-base-aaaaaaaaaaaa-agent-bbbbbbbbbbbb$/);
});

test('a published release prevents duplicate builds', async () => {
  const {options, outputs} = detection();
  options.github.rest.repos.getReleaseByTag = async () => ({data: {draft: false}});
  await checkUpstream(options);
  assert.equal(outputs.build, 'false');
  assert.equal(outputs.plan, undefined);
});

test('a draft release retries an interrupted publication', async () => {
  const {options, outputs} = detection();
  options.github.rest.repos.getReleaseByTag = async () => ({data: {draft: true}});
  await checkUpstream(options);
  assert.equal(outputs.build, 'true');
});

test('partial upstream multi-architecture publication waits for the next poll', async () => {
  const {options, outputs} = detection({channel: 'latest', readJson: async () => ({digest, images: [{os: 'linux', architecture: 'amd64'}]})});
  await checkUpstream(options);
  assert.equal(outputs.build, 'false');
});

test('base-image rebuilds and changes to this repository produce different release IDs', () => {
  const plan = checkUpstream.makePlan(context, '1.26.50-R1', digest);
  assert.notEqual(plan.releaseTag, checkUpstream.makePlan(context, '1.26.50-R1', `sha256:${'c'.repeat(64)}`).releaseTag);
  assert.notEqual(plan.releaseTag, checkUpstream.makePlan({...context, sha: 'd'.repeat(40)}, '1.26.50-R1', digest).releaseTag);
  assert.throws(() => checkUpstream.makePlan(context, '1.26.50-R1', 'bad'), /digest/);
});

test('GitHub permission and service errors are not mistaken for missing releases', async () => {
  const {options} = detection();
  options.github.rest.repos.getReleaseByTag = async () => { throw Object.assign(new Error('Forbidden'), {status: 403}); };
  await assert.rejects(checkUpstream(options), /Forbidden/);
});

test('a draft without a Git tag is found through paginated authenticated listings', async () => {
  const calls = [];
  const github = {rest: {repos: {
    async getReleaseByTag() { throw missing(); },
    async listReleases({page}) {
      calls.push(page);
      return {data: page === 1 ? Array.from({length: 100}, () => ({tag_name: 'other'}))
        : [{id: 99, draft: true, tag_name: 'wanted'}]};
    },
  }}};
  assert.equal((await findRelease(github, context.repo, 'wanted')).id, 99);
  assert.deepEqual(calls, [1, 2]);
});

function publication(t, {draft = null, failUpload = false} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nukkit-publish-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const jar = Buffer.from('test agent JAR');
  fs.writeFileSync(path.join(directory, 'nukkit-mot-javaagent.jar'), jar);
  const calls = [];
  const repos = {
    async getReleaseByTag() { if (!draft) throw missing(); return {data: draft}; },
    async listReleases() { return {data: []}; },
    async createRelease(parameters) { calls.push(['create', parameters]); return {data: {id: 7, draft: true}}; },
    async listReleaseAssets() { return {data: draft ? [{id: 9, name: 'nukkit-mot-javaagent.jar'}] : []}; },
    async deleteReleaseAsset(parameters) { calls.push(['delete', parameters]); },
    async uploadReleaseAsset(parameters) {
      calls.push(['upload', parameters]);
      if (failUpload) throw new Error('Upload interrupted');
    },
    async updateRelease(parameters) { calls.push(['publish', parameters]); },
  };
  return {calls, jar, options: {
    github: {rest: {repos}}, context, core: {info() {}},
    plan: checkUpstream.makePlan(context, '1.26.50-R1', digest),
    imageDigest: `sha256:${'e'.repeat(64)}`, directory,
  }};
}

test('publication creates a draft, uploads checksummed assets, then publishes', async t => {
  const {options, calls, jar} = publication(t);
  await publishRelease(options);
  assert.deepEqual(calls.map(call => call[0]), ['create', 'upload', 'upload', 'upload', 'publish']);
  assert.equal(calls[0][1].draft, true);
  assert.equal(calls[0][1].target_commitish, context.sha);
  const checksum = calls.find(call => call[1].name === 'nukkit-mot-javaagent.jar.sha256')[1].data.toString();
  assert.equal(checksum, `${crypto.createHash('sha256').update(jar).digest('hex')}  nukkit-mot-javaagent.jar\n`);
  const metadata = JSON.parse(calls.find(call => call[1].name === 'image-metadata.json')[1].data);
  assert.equal(metadata.imageDigest, options.imageDigest);
  assert.equal(calls.at(-1)[1].draft, false);
});

test('retrying a draft replaces existing assets before completing it', async t => {
  const {options, calls} = publication(t, {draft: {id: 7, draft: true}});
  await publishRelease(options);
  assert.deepEqual(calls.map(call => call[0]), ['delete', 'upload', 'upload', 'upload', 'publish']);
  assert.equal(calls[0][1].asset_id, 9);
});

test('an asset failure leaves the release as a draft for retry', async t => {
  const {options, calls} = publication(t, {failUpload: true});
  await assert.rejects(publishRelease(options), /Upload interrupted/);
  assert.equal(calls.some(call => call[0] === 'publish'), false);
});

test('an invalid registry digest cannot create a release', async t => {
  const {options, calls} = publication(t);
  options.imageDigest = '';
  await assert.rejects(publishRelease(options), /digest/);
  assert.equal(calls.length, 0);
});
