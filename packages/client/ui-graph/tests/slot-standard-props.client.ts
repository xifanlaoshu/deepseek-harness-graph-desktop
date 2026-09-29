import { vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GlobalStandardProps, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Supply the Client-wide slot hooks that unrelated Graph tests do not call. */
export function graphGlobalStandardProps(): GlobalStandardProps {
  return {
    usePanelInfo: vi.fn(),
    useResource: vi.fn(),
    useSessions: vi.fn(),
    useSessionStatus: vi.fn(),
    useSessionRetainInfo: vi.fn(),
    useWorkspaces: vi.fn(),
  }
}

/** Supply the session slot hooks that unrelated Graph tests do not call. */
export function graphSessionStandardProps(
  useProjection: SessionStandardProps['useProjection'] = vi.fn(),
): SessionStandardProps {
  const inputActions: InputActions = {
    captureInsertion: vi.fn(),
    insertText: vi.fn(),
    setDraft: vi.fn(),
    addAttachments: vi.fn(),
    removeAttachment: vi.fn(),
    pruneAttachments: vi.fn(),
    submit: vi.fn(),
  }
  return {
    useSession: vi.fn(),
    sessionId: SessionId('ui-graph-test'),
    useProjection,
    useConversation: vi.fn(),
    useInput: vi.fn(),
    inputActions,
    useChat: vi.fn(),
    useTrajectory: vi.fn(),
  }
}
