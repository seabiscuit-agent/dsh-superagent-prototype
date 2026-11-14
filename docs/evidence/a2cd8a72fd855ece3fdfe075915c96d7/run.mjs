import { decide, gate } from './extract.mjs'
console.log('dsh toolsHostScopedByDefault =', gate.PROFILES.dsh.toolsHostScopedByDefault)
const WORKER = ['bash','edit','glob','grep','interrupt_agent','job_kill','job_list','job_output','list_agents','list_subagent_models',
  'orchestrator_ack','orchestrator_read','orchestrator_report','orchestrator_thread_follow','orchestrator_thread_unrelated',
  'orchestrator_trigger_handback','read','read_image','send_message','skill','subagent','todo_write','web_search','write']
const ROUTER = ['bash','job_kill','job_list','job_output','orchestrator_eval','orchestrator_eval_decide','orchestrator_eval_read',
  'orchestrator_policy_sync','orchestrator_prompts_save','orchestrator_read','orchestrator_reply','orchestrator_route',
  'orchestrator_settings_save','orchestrator_thread_unsubscribe','orchestrator_ticket_note','orchestrator_ticket_request_status',
  'orchestrator_ticket_retry','orchestrator_trigger_requeue','read','read_image','skill']
const COMPRESS = ['compress','decompress','search_context']
const show = (label, names) => {
  const d = decide(names)
  console.log(`${label.padEnd(42)} compress=${String(d.toolsReachable.compress).padEnd(5)} surfaceOn=${String(d.compressSurfaceOn).padEnd(5)} → nudge ${d.compressSurfaceOn ? 'FIRES' : 'SUPPRESSED'}`)
}
show('worker allow-list (WORK_TOOLS, as today)', WORKER)
show('router allow-list (as today)', ROUTER)
show('worker + compress/decompress/search_context', [...WORKER, ...COMPRESS])
show('router + compress/decompress/search_context', [...ROUTER, ...COMPRESS])
