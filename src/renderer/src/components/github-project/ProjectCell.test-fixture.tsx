import { renderToStaticMarkup } from 'react-dom/server'
import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github/project-types'
import ProjectCell from './ProjectCell'
import { TooltipProvider } from '@/components/ui/tooltip'

export const linkedPullRequestsRow: GitHubProjectRow = {
  id: 'project-item',
  itemType: 'ISSUE',
  content: {
    number: 7,
    title: 'Make linked pull requests easy to open',
    body: null,
    url: 'https://github.com/acme/app/issues/7',
    state: 'CLOSED',
    stateReason: null,
    isDraft: null,
    repository: 'acme/app',
    assignees: [],
    labels: [],
    parentIssue: null,
    issueType: null,
    linkedPullRequests: {
      pullRequests: [
        {
          number: 42,
          title: 'Add clickable PR numbers',
          url: 'https://github.com/acme/app/pull/42'
        },
        {
          number: 93,
          title: 'Support cross-repository links',
          url: 'https://github.example.com/other/api/pull/93'
        }
      ],
      totalCount: 2
    }
  },
  fieldValuesByFieldId: {},
  updatedAt: '2026-10-27T00:00:00Z',
  position: 0
}

const overflowRow: GitHubProjectRow = {
  ...linkedPullRequestsRow,
  id: 'project-item-overflow',
  content: {
    ...linkedPullRequestsRow.content,
    number: 8,
    title: 'Track linked pull request updates',
    url: 'https://github.com/acme/app/issues/8',
    linkedPullRequests: {
      pullRequests: Array.from({ length: 10 }, (_, index) => ({
        number: 1 + index,
        title: `Update linked pull request ${1 + index}`,
        url: `https://github.com/acme/app/pull/${1 + index}`
      })),
      totalCount: 12
    }
  },
  position: 1
}

export const linkedPullRequestsTable: GitHubProjectTable = {
  project: {
    id: 'project',
    owner: 'acme',
    ownerType: 'organization',
    number: 1,
    title: 'Tasks',
    url: 'https://github.com/orgs/acme/projects/1'
  },
  selectedView: {
    id: 'view',
    number: 1,
    name: 'Tasks',
    layout: 'TABLE_LAYOUT',
    filter: '',
    fields: [
      { kind: 'field', id: 'title', name: 'Title', dataType: 'TITLE' },
      {
        kind: 'field',
        id: 'linked',
        name: 'Linked pull requests',
        dataType: 'LINKED_PULL_REQUESTS'
      }
    ],
    groupByFields: [],
    sortByFields: [],
    verticalGroupByFields: []
  },
  rows: [linkedPullRequestsRow, overflowRow],
  totalCount: 2,
  parentFieldDropped: false
}

export function projectRelationCellText(row: GitHubProjectRow): string[] {
  return ['LINKED_PULL_REQUESTS', 'SUB_ISSUES_PROGRESS'].map((dataType) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <ProjectCell
          row={row}
          field={{ kind: 'field', id: dataType, name: dataType, dataType }}
          editable={false}
          sourceTarget={{ kind: 'local' }}
        />
      </TooltipProvider>
    ).replace(/<[^>]*>/g, '')
  )
}
