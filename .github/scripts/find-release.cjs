'use strict';

module.exports = async function findRelease(github, repo, tag) {
  try {
    return (await github.rest.repos.getReleaseByTag({...repo, tag})).data;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  // Drafts can exist before their Git tag does. Search authenticated release
  // listings too so a failed asset upload can resume the existing draft.
  for (let page = 1; ; page++) {
    const {data: releases} = await github.rest.repos.listReleases({...repo, per_page: 100, page});
    const found = releases.find(release => release.tag_name === tag);
    if (found) return found;
    if (releases.length < 100) return null;
  }
};
