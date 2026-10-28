import type { Project } from '../../../shared/project-types'

const indexes = new WeakMap<
  readonly Project[],
  {
    byId: Map<string, number>
    byRepo: Map<string, number>
  }
>()

export function getIndexedLocalRuntimeProject(
  projects: readonly Project[],
  projectId: string,
  repoId: string
): Project | undefined {
  let index = indexes.get(projects)
  if (!index) {
    index = { byId: new Map(), byRepo: new Map() }
    let position = 0
    for (const project of projects) {
      if (!index.byId.has(project.id)) {
        index.byId.set(project.id, position)
      }
      for (const id of [project.id, ...(project.sourceRepoIds ?? [])]) {
        if (!index.byRepo.has(id)) {
          index.byRepo.set(id, position)
        }
      }
      position += 1
    }
    indexes.set(projects, index)
  }
  return projects[
    Math.min(
      index.byId.get(projectId) ?? projects.length,
      index.byRepo.get(repoId) ?? projects.length
    )
  ]
}
