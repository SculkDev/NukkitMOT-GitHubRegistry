'use strict';

const findRelease = require('./find-release.cjs');

const UPSTREAM = 'memoriesoftime/nukkit-mot';
const HUB = `https://hub.docker.com/v2/repositories/${UPSTREAM}/tags`;
const VERSION = /^(\d+)\.(\d+)\.(\d+)-R(\d+)(?:\.(\d+))?$/;

async function getJson(url) {
  const response = await fetch(url, {
    headers: {'User-Agent': 'NukkitMOT-GitHubRegistry'},
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

function compareVersions(left, right) {
  const a = VERSION.exec(left).slice(1).map(value => BigInt(value || 0));
  const b = VERSION.exec(right).slice(1).map(value => BigInt(value || 0));
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

async function findTag(channel, readJson) {
  if (channel !== 'stable') {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(channel)) {
      throw new Error('UPSTREAM_TAG must be stable or a valid Docker tag');
    }
    return channel;
  }
  const tags = [];
  let next = `${HUB}?page_size=100&name=-R`;
  while (next) {
    // Do not follow arbitrary URLs from a remote pagination response.
    const pageUrl = new URL(next);
    if (pageUrl.origin !== 'https://hub.docker.com' || pageUrl.pathname !== new URL(HUB).pathname) {
      throw new Error('Unexpected Docker Hub pagination URL');
    }
    const page = await readJson(next);
    tags.push(...page.results.map(tag => tag.name).filter(name => VERSION.test(name)));
    next = page.next;
  }
  if (!tags.length) throw new Error('Docker Hub has no stable Nukkit-MOT release tags');
  return tags.sort(compareVersions).at(-1);
}

function makePlan(context, tag, digest) {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid upstream image digest');
  if (!/^[0-9a-f]{40}$/.test(context.sha)) throw new Error('Invalid repository commit SHA');
  const image = `ghcr.io/${context.repo.owner}/${context.repo.repo}`.toLowerCase();
  const immutableTag = `${tag}-base-${digest.slice(7, 19)}-agent-${context.sha.slice(0, 12)}`;
  if (immutableTag.length > 128) throw new Error('Generated image tag is too long');
  return {
    upstreamTag: tag,
    upstreamDigest: digest,
    baseImage: `${UPSTREAM}:${tag}@${digest}`,
    image,
    immutableTag,
    tags: [`${image}:latest`, `${image}:${tag}`, `${image}:${immutableTag}`],
    releaseTag: `nukkit-${immutableTag}`,
    revision: context.sha,
  };
}

async function checkUpstream({github, context, core, readJson = getJson,
                              channel = process.env.UPSTREAM_TAG || 'stable'}) {
  core.setOutput('build', 'false');
  const tag = await findTag(channel, readJson);
  const upstream = await readJson(`${HUB}/${encodeURIComponent(tag)}`);
  const platforms = new Set((upstream.images || []).map(image => `${image.os}/${image.architecture}`));
  if (!upstream.digest || !platforms.has('linux/amd64') || !platforms.has('linux/arm64')) {
    core.info(`Upstream ${tag} is not ready on both architectures; checking again next run.`);
    return;
  }
  const plan = makePlan(context, tag, upstream.digest);
  const release = await findRelease(github, context.repo, plan.releaseTag);
  if (release && !release.draft) {
    core.info(`Already published ${plan.releaseTag}; no build needed.`);
    return;
  }
  core.info(`Publishing ${plan.baseImage} as ${plan.tags[0]}`);
  core.setOutput('base_image', plan.baseImage);
  core.setOutput('tags', plan.tags.join('\n'));
  core.setOutput('plan', JSON.stringify(plan));
  core.setOutput('build', 'true');
}

module.exports = checkUpstream;
module.exports.compareVersions = compareVersions;
module.exports.findTag = findTag;
module.exports.makePlan = makePlan;
