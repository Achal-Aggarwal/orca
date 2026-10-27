import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { DashboardAgentRow } from './dashboard/useDashboardData'
import { useClaudeAgentRowView } from './dashboard/use-claude-agent-row-view'

// The viewed row itself carries the current-row highlight; this badge only names a subagent hidden behind a collapsed parent.
export function ClaudeAgentViewIndicator({
  view,
  showChild = true
}: {
  view: { current: boolean; agentId?: string; child: boolean; label?: string } | null
  showChild?: boolean
}) {
  if (!view || view.current || view.child || !showChild || !view.agentId) {
    return null
  }
  const label = translate(
    'auto.components.ClaudeAgentViewIndicator.viewingChild',
    'Viewing subagent {{name}}',
    { name: view.label }
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="max-w-24 shrink-0 truncate rounded-full bg-worktree-sidebar-accent px-1.5 py-0.5 text-3xs font-medium text-foreground"
          aria-label={label}
        >
          {view.label}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        <p>
          {translate(
            'auto.components.ClaudeAgentViewIndicator.returnHint',
            'Click the parent row to return. Esc stops this subagent. Enter sends your draft to this subagent.'
          )}
        </p>
      </TooltipContent>
    </Tooltip>
  )
}

export function ClaudeAgentSummaryViewIndicator({ agent }: { agent: DashboardAgentRow }) {
  return <ClaudeAgentViewIndicator view={useClaudeAgentRowView(agent)} />
}
