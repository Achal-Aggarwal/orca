import { defineFixture } from '../../component-fixtures/component-fixture'
import ProjectViewList from './ProjectViewList'
import { linkedPullRequestsTable } from './ProjectCell.test-fixture'

export const linkedPullRequests = defineFixture({
  width: 860,
  render: () => (
    <ProjectViewList table={linkedPullRequestsTable} sourceTarget={{ kind: 'local' }} />
  ),
  interact: (frame) =>
    frame
      .querySelector<HTMLButtonElement>('button[title="Support cross-repository links"]')
      ?.focus()
})
