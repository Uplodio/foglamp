import {
  getTraceRootContents,
  getTraceToolCalls,
  listTraces,
  type TraceListRow,
} from "@foglamp/clickhouse";

import { extractUserMessage } from "../lib/user-message";
import { decimalOrNull, num, toClickHouseDateTime } from "../lib/util";
import type { Ch, Db } from "../types";
import { requireProjectAccess } from "./access";

// Max traces folded into one timeline. Past this the page says it is cut off
// rather than silently showing a partial story.
const TIMELINE_TRACE_CAP = 300;
// Same caps as the session detail: raw input kept for the disclosure, the
// extracted user message for the bubble. Outputs are capped too — a timeline
// carries up to 300 of them in one payload.
const RAW_INPUT_CAP = 4_000;
const USER_MESSAGE_CAP = 2_000;
const OUTPUT_CAP = 20_000;

type ToolCall = { name: string; count: number; errorCount: number };

// ClickHouse DateTime64 strings are UTC without a zone marker ("2026-10-12 17:00:35.850").
function toMs(value: string): number {
  const ms = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

export type TimelineTurn = {
  traceId: string;
  name: string;
  agentName: string | null;
  workflowName: string | null;
  workflowRunId: string | null;
  sessionId: string | null;
  startTime: string;
  endTime: string;
  durationMs: number;
  status: string;
  userMessage: string | null;
  assistantOutput: string | null;
  rawInput: string | null;
  totalCost: number | null;
  totalTokens: number;
  errorCount: number;
  toolCalls: ToolCall[];
};

export type TimelineRun = {
  /** The grouping key: the session id, else the workflow run id, else the trace id. */
  runId: string;
  kind: "session" | "workflow" | "trace";
  sessionId: string | null;
  workflowRunId: string | null;
  workflowName: string | null;
  /** The first turn's agent — the one that opened the run. */
  agentName: string | null;
  /** Every distinct agent that took a turn, in first-seen order. */
  agents: string[];
  startTime: string;
  endTime: string;
  durationMs: number;
  totalCost: number;
  totalTokens: number;
  errorCount: number;
  /** Tool names in first-call order across the run's turns, deduplicated —
   * the run's shape at a glance (load_case → update_crm → hand_off). */
  toolChain: string[];
  /** The last turn that produced text — what the run reported back. */
  outcome: string | null;
  turns: TimelineTurn[];
};

/**
 * Every trace carrying `metadata[key] = value` in the window, folded into runs
 * and told in order. A run is the traces that share a session id (one
 * delegation, one chat), else a workflow run (one sweep — the metadata filter
 * already narrows it to this value's turns), else a lone trace. Sessions and
 * workflow runs are both first-class in Foglamp; this view is for a value that
 * cuts across them — a customer's record, a ticket, a creator — where the
 * question is "what happened to X" rather than "what did run Y do".
 */
export async function getMetadataTimeline(
  db: Db,
  ch: Ch,
  userId: string,
  input: { projectId: string; key: string; value: string; from: Date; to: Date },
) {
  await requireProjectAccess(db, userId, input.projectId);

  const traces = await listTraces(ch, {
    projectId: input.projectId,
    metadataKey: input.key,
    metadataValue: input.value,
    from: toClickHouseDateTime(input.from),
    to: toClickHouseDateTime(input.to),
    sort: { field: "when", dir: "asc" },
    limit: TIMELINE_TRACE_CAP,
  });
  const traceIds = traces.map((t) => t.trace_id);
  const [contents, toolCalls] = await Promise.all([
    getTraceRootContents(ch, { projectId: input.projectId, traceIds }),
    getTraceToolCalls(ch, { projectId: input.projectId, traceIds }),
  ]);
  const contentByTrace = new Map(contents.map((c) => [c.trace_id, c]));
  const toolsByTrace = new Map<string, ToolCall[]>();
  for (const t of toolCalls) {
    const list = toolsByTrace.get(t.trace_id) ?? [];
    list.push({ name: t.name, count: num(t.call_count), errorCount: num(t.error_count) });
    toolsByTrace.set(t.trace_id, list);
  }

  const turns: TimelineTurn[] = traces.map((m: TraceListRow) => {
    const c = contentByTrace.get(m.trace_id);
    return {
      traceId: m.trace_id,
      name: c?.name || m.trace_name,
      agentName: m.agent_name || null,
      workflowName: m.workflow_name || null,
      workflowRunId: m.workflow_run_id || null,
      sessionId: m.session_id || null,
      startTime: c?.start_time ?? m.trace_start,
      endTime: c?.end_time ?? m.trace_end,
      durationMs: num(m.duration_ms),
      status: c?.status ?? (num(m.error_count) > 0 ? "error" : "ok"),
      userMessage: extractUserMessage(c?.input, USER_MESSAGE_CAP),
      assistantOutput: c?.output ? c.output.slice(0, OUTPUT_CAP) : null,
      rawInput: c?.input ? c.input.slice(0, RAW_INPUT_CAP) : null,
      totalCost: decimalOrNull(m.total_cost),
      totalTokens: num(m.total_tokens),
      errorCount: num(m.error_count),
      toolCalls: toolsByTrace.get(m.trace_id) ?? [],
    };
  });

  // Fold turns into runs, keeping first-seen order (turns arrive oldest first).
  const runs: TimelineRun[] = [];
  const runByKey = new Map<string, TimelineRun>();
  for (const turn of turns) {
    const kind = turn.sessionId ? "session" : turn.workflowRunId ? "workflow" : "trace";
    const runId = turn.sessionId ?? turn.workflowRunId ?? turn.traceId;
    const key = `${kind}:${runId}`;
    let run = runByKey.get(key);
    if (!run) {
      run = {
        runId,
        kind,
        sessionId: turn.sessionId,
        workflowRunId: turn.workflowRunId,
        workflowName: turn.workflowName,
        agentName: turn.agentName,
        agents: [],
        startTime: turn.startTime,
        endTime: turn.endTime,
        durationMs: 0,
        totalCost: 0,
        totalTokens: 0,
        errorCount: 0,
        toolChain: [],
        outcome: null,
        turns: [],
      };
      runByKey.set(key, run);
      runs.push(run);
    }
    run.turns.push(turn);
    if (turn.agentName && !run.agents.includes(turn.agentName)) run.agents.push(turn.agentName);
    if (!run.workflowName && turn.workflowName) run.workflowName = turn.workflowName;
    if (turn.endTime > run.endTime) run.endTime = turn.endTime;
    run.totalCost += turn.totalCost ?? 0;
    run.totalTokens += turn.totalTokens;
    run.errorCount += turn.errorCount;
    for (const tc of turn.toolCalls) if (!run.toolChain.includes(tc.name)) run.toolChain.push(tc.name);
    if (turn.assistantOutput?.trim()) run.outcome = turn.assistantOutput;
  }
  for (const run of runs) {
    run.durationMs = Math.max(0, toMs(run.endTime) - toMs(run.startTime));
  }

  return {
    key: input.key,
    value: input.value,
    truncated: traces.length >= TIMELINE_TRACE_CAP,
    stats: {
      runCount: runs.length,
      turnCount: turns.length,
      totalCost: turns.reduce((acc, t) => acc + (t.totalCost ?? 0), 0),
      totalTokens: turns.reduce((acc, t) => acc + t.totalTokens, 0),
      errorCount: turns.reduce((acc, t) => acc + t.errorCount, 0),
      firstSeen: turns[0]?.startTime ?? null,
      lastSeen: turns[turns.length - 1]?.endTime ?? null,
    },
    runs,
  };
}
