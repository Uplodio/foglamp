import {
  getCustomerDisplays,
  getTraceRootContents,
  getTraceToolCalls,
  listTraces,
  type TraceListRow,
} from "@foglamp/clickhouse";

import { userMessageSnippet } from "../lib/user-message";
import { decimalOrNull, num, toClickHouseDateTime } from "../lib/util";
import type { Ch, Db } from "../types";
import { requireProjectAccess } from "./access";

// Max traces folded into one timeline. Past this the page says it is cut off
// rather than silently showing a partial story.
const TIMELINE_TRACE_CAP = 300;
// A run's opening input is the first turn's root payload — a delegation
// prompt or a chat message, short by nature — kept whole (within reason) so
// the drawer's exchange can render it as a transcript. Outputs are text.
const OPENING_INPUT_CAP = 64_000;
const OUTPUT_CAP = 20_000;
// One-line title snippet, matching the traces and sessions lists.
const USER_MESSAGE_SNIPPET_CAP = 300;

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
  startTime: string;
  endTime: string;
  durationMs: number;
  status: string;
  totalCost: number | null;
  totalTokens: number;
  errorCount: number;
  abortedCount: number;
  models: string[];
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
  /** Every model any turn used, in first-use order. */
  models: string[];
  firstTraceId: string;
  lastTraceId: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  totalCost: number;
  totalTokens: number;
  errorCount: number;
  abortedCount: number;
  /** One line of the opening user message — the row title. */
  openingMessage: string | null;
  /** The first turn's root input, whole — the drawer's transcript. */
  openingInput: string | null;
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
  // The value's customer: a record belongs to one tenant, so the first trace
  // that names one speaks for the timeline (same rule as a workflow run).
  const customerId = traces.find((t) => t.customer_id)?.customer_id ?? null;
  const [contents, toolCalls, customerDims] = await Promise.all([
    getTraceRootContents(ch, { projectId: input.projectId, traceIds }),
    getTraceToolCalls(ch, { projectId: input.projectId, traceIds }),
    customerId
      ? getCustomerDisplays(ch, { projectId: input.projectId, customerIds: [customerId] })
      : Promise.resolve([]),
  ]);
  const customer = customerId
    ? {
        customerId,
        customerName: customerDims[0]?.customer_name || null,
        customerImageUrl: customerDims[0]?.customer_image_url || null,
      }
    : null;
  const contentByTrace = new Map(contents.map((c) => [c.trace_id, c]));
  const toolsByTrace = new Map<string, ToolCall[]>();
  for (const t of toolCalls) {
    const list = toolsByTrace.get(t.trace_id) ?? [];
    list.push({ name: t.name, count: num(t.call_count), errorCount: num(t.error_count) });
    toolsByTrace.set(t.trace_id, list);
  }

  const turnOf = (m: TraceListRow): TimelineTurn => {
    const c = contentByTrace.get(m.trace_id);
    return {
      traceId: m.trace_id,
      name: c?.name || m.trace_name,
      agentName: m.agent_name || null,
      startTime: c?.start_time ?? m.trace_start,
      endTime: c?.end_time ?? m.trace_end,
      durationMs: num(m.duration_ms),
      status: c?.status ?? (num(m.error_count) > 0 ? "error" : "ok"),
      totalCost: decimalOrNull(m.total_cost),
      totalTokens: num(m.total_tokens),
      errorCount: num(m.error_count),
      abortedCount: num(m.aborted_count),
      models: m.models ?? [],
      toolCalls: toolsByTrace.get(m.trace_id) ?? [],
    };
  };

  // Fold traces into runs, keeping first-seen order (they arrive oldest first).
  const runs: TimelineRun[] = [];
  const runByKey = new Map<string, TimelineRun>();
  for (const m of traces) {
    const turn = turnOf(m);
    const sessionId = m.session_id || null;
    const workflowRunId = m.workflow_run_id || null;
    const kind = sessionId ? "session" : workflowRunId ? "workflow" : "trace";
    const runId = sessionId ?? workflowRunId ?? m.trace_id;
    const key = `${kind}:${runId}`;
    let run = runByKey.get(key);
    if (!run) {
      const c = contentByTrace.get(m.trace_id);
      run = {
        runId,
        kind,
        sessionId,
        workflowRunId,
        workflowName: m.workflow_name || null,
        agentName: turn.agentName,
        agents: [],
        models: [],
        firstTraceId: m.trace_id,
        lastTraceId: m.trace_id,
        startTime: turn.startTime,
        endTime: turn.endTime,
        durationMs: 0,
        totalCost: 0,
        totalTokens: 0,
        errorCount: 0,
        abortedCount: 0,
        openingMessage: userMessageSnippet(c?.input, USER_MESSAGE_SNIPPET_CAP),
        openingInput: c?.input ? c.input.slice(0, OPENING_INPUT_CAP) : null,
        outcome: null,
        turns: [],
      };
      runByKey.set(key, run);
      runs.push(run);
    }
    run.turns.push(turn);
    run.lastTraceId = m.trace_id;
    if (turn.agentName && !run.agents.includes(turn.agentName)) run.agents.push(turn.agentName);
    for (const model of turn.models) if (!run.models.includes(model)) run.models.push(model);
    if (!run.workflowName && m.workflow_name) run.workflowName = m.workflow_name;
    if (turn.endTime > run.endTime) run.endTime = turn.endTime;
    run.totalCost += turn.totalCost ?? 0;
    run.totalTokens += turn.totalTokens;
    run.errorCount += turn.errorCount;
    run.abortedCount += turn.abortedCount;
    const output = contentByTrace.get(m.trace_id)?.output;
    if (output?.trim()) run.outcome = output.slice(0, OUTPUT_CAP);
  }
  for (const run of runs) {
    run.durationMs = Math.max(0, toMs(run.endTime) - toMs(run.startTime));
  }

  const firstSeen = runs[0]?.startTime ?? null;
  const lastSeen = runs.reduce<string | null>(
    (acc, r) => (acc === null || r.endTime > acc ? r.endTime : acc),
    null,
  );
  const models: string[] = [];
  for (const run of runs) for (const model of run.models) if (!models.includes(model)) models.push(model);
  return {
    key: input.key,
    value: input.value,
    truncated: traces.length >= TIMELINE_TRACE_CAP,
    customer,
    models,
    stats: {
      runCount: runs.length,
      erroredRunCount: runs.filter((r) => r.errorCount > 0).length,
      traceCount: traces.length,
      totalCost: runs.reduce((acc, r) => acc + r.totalCost, 0),
      totalTokens: runs.reduce((acc, r) => acc + r.totalTokens, 0),
      errorCount: runs.reduce((acc, r) => acc + r.errorCount, 0),
      firstSeen,
      lastSeen,
      // First trace start → last trace end: how long this value has been in play.
      spanMs: firstSeen && lastSeen ? Math.max(0, toMs(lastSeen) - toMs(firstSeen)) : 0,
    },
    runs,
  };
}
