export function isReleasePr(event, repository) {
  const pr = event.pull_request;
  return Boolean(repository && pr?.base?.ref === 'main'
    && pr.base.repo?.full_name === repository
    && pr.head?.repo?.full_name === repository
    && pr.head.ref === 'changeset-release/main');
}

export function mergedReleaseSha(event, repository) {
  if (event.action !== 'closed' || event.pull_request?.merged !== true || !isReleasePr(event, repository)) {
    throw new Error('Only a merged same-repository Changesets release PR can create a release');
  }
  const sha = event.pull_request.merge_commit_sha;
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Missing or invalid release merge commit');
  return sha;
}
