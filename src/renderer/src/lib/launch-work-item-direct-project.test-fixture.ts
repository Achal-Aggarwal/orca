export function directWorkItemProjectFixture() {
  return {
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        addedAt: 1
      }
    ],
    activeRepoId: 'repo-1',
    activeWorktreeId: null,
    projects: [
      {
        id: 'repo-1',
        displayName: 'Repo',
        badgeColor: '#000000',
        sourceRepoIds: ['repo-1'],
        createdAt: 1,
        updatedAt: 1
      }
    ]
  }
}
