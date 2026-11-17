/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { latestAssignment, liveTicket, UserError, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext' | 'resolveQuestion'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  sendReplies(): Promise<void>
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_resolve',
      description: 'Close a question you asked that no longer needs an answer, such as one whose premise changed; only the assignment that asked it may resolve it.',
      schema: z.object({ question_id: z.string().min(1).describe('The question id returned when you asked it.') }).strict(),
      execute: async args => {
        const current = host.store.tickets.get(ticketId)
        const assignment = current ? latestAssignment(current) : undefined
        if (!assignment) throw new UserError('unknownAssignment')
        const { questionId } = host.engine.resolveQuestion(ticketId, args.question_id, assignment.id)
        return { resolved: true, question_id: questionId }
      },
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person (alias of question, and question_for=person), also with state=progress; omit to leave open questions alone, null to withdraw this assignment\'s open ones.'),
        question: z.string().trim().min(1).max(1000).nullish().describe('A question: the main Session answers it by default, or a person with question_for=person. Omit to leave open questions alone, null to withdraw this assignment\'s open ones.'),
        question_for: z.enum(['orchestrator', 'person']).optional().describe('Who answers the question; defaults to person. Ask the orchestrator for direction within its existing work, and a person only for decisions or resources the orchestrator cannot supply.'),
        options: z.array(z.string().trim().min(1).max(200)).min(2).max(5).optional().describe('Two to five choices, when the question has them.'),
        recommend: z.string().trim().min(1).max(200).optional().describe('One of options that you recommend.'),
        key: z.string().optional().describe('Stable name: a later open question with the same key updates this one instead of asking a new one.'),
        context: z.string().trim().min(1).max(500).optional().describe('Why you ask, in your own words; shown with the question.'),
        question_for_trigger_id: z.string().optional().describe('With a question for a person: the human message that raised it, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe(`The ticket's PR: its source PR, or one by ${host.github.deployment.github.login} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
      }).strict(),
      execute: async (args, signal) => {
        if (args.question !== undefined && args.human_action !== undefined) throw new UserError('ambiguousQuestion')
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          const question = args.question !== undefined ? args.question : args.human_action
          const report = { state: args.state, summary: args.summary,
            ...(question !== undefined ? { question, questionFor: args.question_for ?? 'person' } : {}),
            ...(args.options ? { options: args.options } : {}), ...(args.recommend ? { recommend: args.recommend } : {}),
            ...(args.key ? { questionKey: args.key } : {}), ...(args.context ? { context: args.context } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const asked = latestAssignment(updated)?.report?.questionId
          const open = asked ? updated.questions?.find(item => item.id === asked && item.resolution === undefined) : undefined
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(open ? { question: { id: open.id, question: open.question, to: open.to,
            ...(open.options ? { options: open.options } : {}), ...(open.recommend ? { recommend: open.recommend } : {}), blocking: open.blocking } } : {}) }
        })
      },
    }),
  ]
}
