/** Shared renderers for the messages a ticket's questions produce. */
import type { Question } from '../core/index.ts'

/** The message that asks a person a worker's question, including the choices and any escalation reason. */
export function attentionText(question: Question): string {
  const lines = [question.question]
  if (question.options?.length) {
    const options = question.options.join(' / ')
    lines.push(`Options: ${options}${question.recommend ? ` (recommended: ${question.recommend})` : ''}`)
  }
  if (question.context) lines.push(question.context)
  if (question.escalation) lines.push(`Escalated: ${question.escalation}`)
  return lines.join('\n\n')
}
