'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const findRelease = require('./find-release.cjs');

async function publishRelease({github, context, core, plan = JSON.parse(process.env.RELEASE_PLAN),
                               imageDigest = process.env.IMAGE_DIGEST, directory = 'dist'}) {
  if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) throw new Error('Missing or invalid published image digest');
  const metadata = {...plan, imageDigest, runUrl:
    `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`};
  const jarName = 'nukkit-mot-javaagent.jar';
  const jar = fs.readFileSync(`${directory}/${jarName}`);
  const checksum = `${crypto.createHash('sha256').update(jar).digest('hex')}  ${jarName}\n`;
  const assets = [
    {name: jarName, data: jar, type: 'application/java-archive'},
    {name: `${jarName}.sha256`, data: Buffer.from(checksum), type: 'text/plain'},
    {name: 'image-metadata.json', data: Buffer.from(JSON.stringify(metadata, null, 2) + '\n'), type: 'application/json'},
  ];
  const body = [
    `Based on Docker Hub [${plan.baseImage}](https://hub.docker.com/r/memoriesoftime/nukkit-mot/tags?name=${encodeURIComponent(plan.upstreamTag)}).`,
    '',
    'Palette downloads are redirected from `bin-data.nkmot.com` to `raw.githubusercontent.com`.',
    'Includes `linux/amd64` and `linux/arm64`; upstream `/data`, `JAVA_OPTS`, user and entrypoint are preserved.',
    '',
    '```sh',
    `docker pull ${plan.image}:${plan.immutableTag}`,
    `docker run -d --name nukkit-mot -p 19132:19132/udp -p 19132:19132/tcp -v nukkit-data:/data -e JAVA_OPTS="-Xms2G -Xmx2G" --restart unless-stopped ${plan.image}:${plan.immutableTag}`,
    '```',
    '',
    `Aliases: \`${plan.image}:latest\` and \`${plan.image}:${plan.upstreamTag}\`.`,
    `Published image digest: \`${imageDigest}\`.`,
    `Agent source commit: \`${plan.revision}\`.`,
    '',
    'The standalone agent and its SHA-256 checksum are attached for installations without Docker.',
  ].join('\n');

  let release = await findRelease(github, context.repo, plan.releaseTag);
  if (release && !release.draft) {
    core.info(`Release ${plan.releaseTag} is already published.`);
    return;
  }
  if (!release) {
    ({data: release} = await github.rest.repos.createRelease({
      ...context.repo, tag_name: plan.releaseTag, target_commitish: plan.revision,
      name: `Nukkit-MOT ${plan.upstreamTag} + GitHub palette redirect`, body, draft: true,
    }));
  }
  // A draft is the retry checkpoint. Only a fully uploaded, published release
  // tells the detector that this upstream digest + agent commit is complete.
  const {data: existing} = await github.rest.repos.listReleaseAssets({...context.repo, release_id: release.id, per_page: 100});
  for (const asset of assets) {
    const previous = existing.find(item => item.name === asset.name);
    if (previous) await github.rest.repos.deleteReleaseAsset({...context.repo, asset_id: previous.id});
    await github.rest.repos.uploadReleaseAsset({
      ...context.repo, release_id: release.id, name: asset.name, data: asset.data,
      headers: {'content-type': asset.type, 'content-length': asset.data.length},
    });
  }
  await github.rest.repos.updateRelease({
    ...context.repo, release_id: release.id, name: `Nukkit-MOT ${plan.upstreamTag} + GitHub palette redirect`,
    body, draft: false, prerelease: false, make_latest: 'true',
  });
  core.info(`Published ${plan.releaseTag} and ${plan.image}@${imageDigest}`);
}

module.exports = publishRelease;
