import { defineFixture } from '../../component-fixtures/component-fixture'
import ProjectViewList from './ProjectViewList'
import { linkedPullRequestsTable } from './ProjectCell.test-fixture'

export const linkedPullRequests = defineFixture({
  width: 1360,
  render: () => (
    <div className="relative flex min-h-0 flex-1 bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col px-5 pt-1.5 pb-4 md:px-8 md:pb-5">
        <div className="mt-3 flex min-h-0 min-w-0 max-h-full flex-col overflow-hidden rounded-md border border-border/50 bg-muted/50 shadow-sm">
          <ProjectViewList table={linkedPullRequestsTable} sourceTarget={{ kind: 'local' }} />
        </div>
      </div>
    </div>
  )
})
