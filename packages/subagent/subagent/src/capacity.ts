/** Shared active-subagent capacity inherited by an in-process delegation tree. @module @deepseek-ai/dsh-subagent/capacity */

import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity of one independently accounted active-subagent pool. */
export type SubagentCapacityScopeId = Branded<'SubagentCapacityScopeId'>

/**
 * Brand one validated capacity-pool identity.
 * @param value normalized non-empty capacity-pool identity.
 * @returns branded capacity-pool identity.
 */
export function SubagentCapacityScopeId(value: string): SubagentCapacityScopeId {
  if (!value.trim() || value !== value.trim() || value.length > 512) {
    throw new TypeError('subagent capacity scope must be normalized non-empty text of at most 512 characters')
  }
  return value as SubagentCapacityScopeId
}

/** Active-agent ceiling inherited by every child in one delegation tree. */
export interface SubagentCapacity {
  readonly scope: SubagentCapacityScopeId
  readonly maxActive: number
}

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** Active-subagent pool inherited monotonically by in-process descendants. */
    subagentCapacity?: SubagentCapacity
  }
}

/**
 * Validate and detach one optional capacity declaration.
 * @param value optional capacity declaration from an agent boundary.
 * @returns detached validated capacity, or `undefined` when omitted.
 */
export function validateSubagentCapacity(value: SubagentCapacity | undefined): SubagentCapacity | undefined {
  if (value === undefined) return undefined
  const scope = SubagentCapacityScopeId(value.scope)
  if (!Number.isSafeInteger(value.maxActive) || value.maxActive < 1) {
    throw new TypeError('subagent capacity maxActive must be a positive safe integer')
  }
  return { scope, maxActive: value.maxActive }
}

/**
 * Resolve inherited capacity without permitting a descendant to replace or widen it.
 * @param parent delegating parent agent.
 * @param requested optional child agent options.
 * @returns inherited or newly declared capacity, or `undefined` when neither exists.
 */
export function resolveSubagentCapacity(
  parent: Agent,
  requested: AgentOptions | undefined,
): SubagentCapacity | undefined {
  const inherited = validateSubagentCapacity(parent.options.subagentCapacity)
  const declared = validateSubagentCapacity(requested?.subagentCapacity)
  if (inherited !== undefined && declared !== undefined
    && (inherited.scope !== declared.scope || inherited.maxActive !== declared.maxActive)) {
    throw new TypeError('a child cannot replace or widen its inherited subagent capacity')
  }
  return inherited ?? declared
}
