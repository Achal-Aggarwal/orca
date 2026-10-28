import type { useStructuredAgentSession } from './use-structured-agent-session'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { NativeChatStructuredSessionStatus } from './NativeChatStructuredSessionStatus'
import { NativeChatStructuredGoalStrip } from './NativeChatStructuredGoalStrip'

export function NativeChatStructuredActivity(props: {
  controller: Pick<
    ReturnType<typeof useStructuredAgentSession>,
    | 'backgroundTasks'
    | 'stopBackgroundTask'
    | 'threadGoal'
    | 'isWorking'
    | 'turnId'
    | 'workingStartedAt'
  >
  sessionId: string
  paneKey: string
  isVisible: boolean
  transport: NativeChatStructuredComposerTransport
  showGoal: boolean
}): React.JSX.Element {
  const { controller } = props
  return (
    <>
      <NativeChatStructuredSessionStatus
        sessionId={props.sessionId}
        paneKey={props.paneKey}
        isVisible={props.isVisible}
        backgroundTasks={controller.backgroundTasks}
        stopBackgroundTask={controller.stopBackgroundTask}
      />
      {props.showGoal ? (
        <NativeChatStructuredGoalStrip
          sessionId={props.sessionId}
          threadGoal={controller.threadGoal}
          transport={props.transport}
          isWorking={controller.isWorking}
          isVisible={props.isVisible}
          turnId={controller.turnId}
          workingStartedAt={controller.workingStartedAt}
        />
      ) : null}
    </>
  )
}
