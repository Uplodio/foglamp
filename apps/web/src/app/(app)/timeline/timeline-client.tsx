"use client";

import { Badge } from "@foglamp/ui/components/badge";
import { Skeleton } from "@foglamp/ui/components/skeleton";
import { cn } from "@foglamp/ui/lib/utils";
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconChevronDown,
  IconChevronRight,
  IconGhostFilled,
  IconHistory,
  IconMessage2Filled,
  IconPlayerStopFilled,
  IconSitemapFilled,
  IconTool,
  IconUserFilled,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { Route } from "next";
import Link from "next/link";
import { Fragment, useState } from "react";
import { Streamdown } from "streamdown";

import { AgentIcon } from "@/components/app/agent-icon";
import { Chip } from "@/components/app/context-chip";
import { useUrlFilters } from "@/components/app/data-table";
import { useDelayedLoading } from "@/components/app/hooks";
import { markdownComponents } from "@/components/app/markdown";
import { EmptyState, NoProject } from "@/components/app/page-parts";
import { ClampedBody } from "@/components/app/payload-view";
import { useProject } from "@/components/app/project-context";
import { useRange } from "@/components/app/range-context";
import { RelativeTime } from "@/components/app/relative-time";
import {
  formatCost,
  formatDateTime,
  formatSpanDuration,
  formatTokens,
} from "@/lib/format";
import { type RouterOutputs, trpc } from "@/utils/trpc";
import { TimelineHeader } from "./header";

type Timeline = RouterOutputs["traces"]["timeline"];
type Run = Timeline["runs"][number];
type Turn = Run["turns"][number];

/**
 * "What happened to X": every trace carrying one metadata value, folded into
 * runs (a session, a workflow run, or a lone trace) and told oldest first.
 * Each run leads with its shape (the tool chain) and what it reported back,
 * with the turn-by-turn conversation one click away — the session page's
 * turn view, without having to open each trace and back out.
 */
export function TimelineClient() {
  const { projectId } = useProject();
  const { range } = useRange();
  const [params] = useUrlFilters({ key: "", value: "" });
  const key = params.key;
  const value = params.value;
  const ready = !!key && !!value;
  const backHref = key
    ? (`/traces?metaKey=${encodeURIComponent(key)}${
        value ? `&metaValue=${encodeURIComponent(value)}` : ""
      }` as Route)
    : undefined;

  const timeline = useQuery({
    ...trpc.traces.timeline.queryOptions({
      projectId: projectId!,
      key,
      value,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    }),
    enabled: !!projectId && ready,
    // Keep the current story visible while a range change reloads it.
    placeholderData: (prev) => prev,
  });
  const loading = useDelayedLoading(ready && timeline.isLoading);

  const description = ready ? (
    <span className="font-mono text-xs">
      {key} = {value}
    </span>
  ) : undefined;
  const header = (
    <TimelineHeader backHref={backHref} description={description} />
  );

  if (!projectId) {
    return (
      <>
        {header}
        <NoProject />
      </>
    );
  }

  if (!ready) {
    return (
      <>
        {header}
        <div className="mt-6 px-8">
          <EmptyState
            icon={IconHistory}
            title="Pick a metadata value"
            description="Open Traces, filter by a metadata key and value, then press Timeline."
          />
        </div>
      </>
    );
  }

  const data = timeline.data;
  return (
    <>
      {header}
      <div className="mt-6 flex flex-col gap-4 px-8 pb-12">
        {timeline.error ? (
          <EmptyState
            icon={IconAlertTriangle}
            title="Couldn't load the timeline"
            description={timeline.error.message}
          />
        ) : !data ? (
          loading ? (
            <TimelineSkeleton />
          ) : null
        ) : data.runs.length === 0 ? (
          <EmptyState
            icon={IconHistory}
            title={`No traces carry ${key} = ${value} in this range`}
            description="The timeline only covers the selected window — widen the range to look further back."
          />
        ) : (
          <>
            <Summary data={data} />
            <ol className="flex flex-col gap-4">
              {data.runs.map((run, i) => (
                <RunCard key={`${run.kind}:${run.runId}`} run={run} index={i} />
              ))}
            </ol>
          </>
        )}
      </div>
    </>
  );
}

function Summary({ data }: { data: Timeline }) {
  const { stats } = data;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground tabular-nums">
        {stats.runCount} {stats.runCount === 1 ? "run" : "runs"}
      </span>
      <span>·</span>
      <span className="tabular-nums">
        {stats.turnCount} {stats.turnCount === 1 ? "turn" : "turns"}
      </span>
      <span>·</span>
      <span className="tabular-nums">{formatCost(stats.totalCost)}</span>
      <span>·</span>
      <span className="tabular-nums">{formatTokens(stats.totalTokens)} tokens</span>
      {stats.firstSeen && stats.lastSeen && (
        <>
          <span>·</span>
          <span>
            {formatDateTime(stats.firstSeen)} → {formatDateTime(stats.lastSeen)}
          </span>
        </>
      )}
      {stats.errorCount > 0 && (
        <Badge variant="rose">
          <IconAlertTriangle />
          {stats.errorCount} {stats.errorCount === 1 ? "error" : "errors"}
        </Badge>
      )}
      {data.truncated && (
        <Badge variant="amber">
          <IconAlertTriangle />
          Cut off at 300 traces — narrow the range
        </Badge>
      )}
    </div>
  );
}

function RunCard({ run, index }: { run: Run; index: number }) {
  const [open, setOpen] = useState(false);
  const hasError = run.errorCount > 0;
  const turnWord = run.turns.length === 1 ? "turn" : "turns";
  return (
    <li
      className={cn(
        "corner-squircle rounded-xl border bg-card/40 shadow-(--custom-shadow)",
        hasError && "border-rose-500/40",
      )}
    >
      {/* Run header: who ran, where it lives (session / workflow run), when, and its rollups. */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">
          Run {index + 1}
        </span>
        <span>·</span>
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <AgentIcon name={run.agentName} className="size-3.5" />
          {run.agentName ?? "—"}
        </span>
        {run.agents.length > 1 && (
          <span title={run.agents.join(", ")}>+{run.agents.length - 1} more</span>
        )}
        {run.workflowName && (
          <Link
            href={
              `/workflows/${encodeURIComponent(run.workflowName)}${
                run.workflowRunId
                  ? `?run=${encodeURIComponent(run.workflowRunId)}`
                  : ""
              }` as Route
            }
            className="inline-flex items-center gap-1 rounded-full border bg-card/40 px-2 py-0.5 transition-colors hover:text-foreground"
            title="Open the workflow run"
          >
            <IconSitemapFilled className="size-3 shrink-0 text-emerald-500" />
            <span className="max-w-40 truncate">{run.workflowName}</span>
          </Link>
        )}
        {run.sessionId && (
          <Link
            href={`/sessions/${encodeURIComponent(run.sessionId)}`}
            className="inline-flex items-center gap-1 rounded-full border bg-card/40 px-2 py-0.5 transition-colors hover:text-foreground"
            title="Open the session"
          >
            <IconMessage2Filled className="size-3 shrink-0 text-sky-500" />
            Session
          </Link>
        )}
        <span>·</span>
        <span title={formatDateTime(run.startTime)}>
          <RelativeTime value={run.startTime} />
        </span>
        <span>·</span>
        <span className="tabular-nums">
          {run.turns.length} {turnWord}
        </span>
        <span>·</span>
        <span className="tabular-nums">{formatSpanDuration(run.durationMs)}</span>
        <span>·</span>
        <span className="tabular-nums">{formatCost(run.totalCost)}</span>
        <span>·</span>
        <span className="tabular-nums">{formatTokens(run.totalTokens)} tokens</span>
        {hasError && (
          <Badge variant="rose">
            <IconAlertTriangle />
            {run.errorCount} {run.errorCount === 1 ? "error" : "errors"}
          </Badge>
        )}
      </div>

      {/* The run's shape: tool names in first-call order. */}
      {run.toolChain.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
          {run.toolChain.map((name, i) => (
            <Fragment key={name}>
              {i > 0 && (
                <IconChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
              )}
              <Chip
                icon={
                  <IconTool className="mb-px size-3 shrink-0 fill-current stroke-1 text-blue-500" />
                }
                label={<span className="font-mono">{name}</span>}
              />
            </Fragment>
          ))}
        </div>
      )}

      {/* What the run reported back — the last turn with text. */}
      <div className="border-t border-border/40 px-4 py-3">
        {run.outcome ? (
          <ClampedBody maxHeight={160}>
            <Bubble role="assistant" text={run.outcome} />
          </ClampedBody>
        ) : (
          <p className="pl-9 text-sm text-muted-foreground italic">
            No text output captured.
          </p>
        )}
      </div>

      <div className="border-t border-border/40 px-4 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {open ? (
            <IconChevronDown className="size-3.5" />
          ) : (
            <IconChevronRight className="size-3.5" />
          )}
          {open ? "Hide turns" : `Show ${run.turns.length} ${turnWord}`}
        </button>
        {open && (
          <div className="mt-4 flex flex-col gap-6">
            {run.turns.map((turn, i) => (
              <TurnView
                key={turn.traceId}
                turn={turn}
                index={i}
                previousUserMessage={run.turns[i - 1]?.userMessage ?? null}
              />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/** One turn, in the session page's shape. The user bubble is skipped when it
 * repeats the previous turn's — an agent loop re-sends the same delegation
 * prompt on every step, and once is enough. */
function TurnView({
  turn,
  index,
  previousUserMessage,
}: {
  turn: Turn;
  index: number;
  previousUserMessage: string | null;
}) {
  const isError = turn.status === "error";
  const isAborted = turn.status === "aborted";
  const showUser =
    !!turn.userMessage && turn.userMessage !== previousUserMessage;
  return (
    <div
      className={cn(
        "flex flex-col gap-3 border-l-2 pl-4",
        isError
          ? "border-rose-500"
          : isAborted
            ? "border-amber-500"
            : "border-border/60",
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">
          Turn {index + 1}
        </span>
        <span>·</span>
        <span className="inline-flex items-center gap-1.5">
          <AgentIcon name={turn.agentName} className="size-3.5" />
          {turn.agentName ?? "—"}
        </span>
        <span>·</span>
        <span>{formatDateTime(turn.startTime)}</span>
        <span>·</span>
        <span className="tabular-nums">{formatCost(turn.totalCost)}</span>
        <span>·</span>
        <span className="tabular-nums">{formatTokens(turn.totalTokens)} tokens</span>
        <span>·</span>
        <span className="tabular-nums">{formatSpanDuration(turn.durationMs)}</span>
        {isError && (
          <Badge variant="rose">
            <IconAlertTriangle />
            Error
          </Badge>
        )}
        {isAborted && (
          <Badge variant="amber">
            <IconPlayerStopFilled />
            Aborted
          </Badge>
        )}
        <Link
          href={`/traces/${encodeURIComponent(turn.traceId)}`}
          className="ml-2 inline-flex items-center gap-0.5 transition-colors hover:text-foreground"
        >
          Trace
          <IconArrowUpRight className="size-3.5" />
        </Link>
      </div>

      {showUser && turn.userMessage && (
        <Bubble role="user" text={turn.userMessage} raw={turn.rawInput} />
      )}
      {turn.toolCalls.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pl-9">
          {turn.toolCalls.map((tc) => (
            <Chip
              key={tc.name}
              href={`/traces/${encodeURIComponent(turn.traceId)}`}
              title={`View ${tc.name} in the trace`}
              tone={tc.errorCount > 0 ? "error" : "ok"}
              icon={
                <IconTool
                  className={cn(
                    "mb-px size-3 shrink-0 fill-current stroke-1",
                    tc.errorCount > 0 ? "text-current" : "text-blue-500",
                  )}
                />
              }
              label={<span className="font-mono">{tc.name}</span>}
              trailing={tc.count > 1 ? `×${tc.count}` : undefined}
            />
          ))}
        </div>
      )}
      {turn.assistantOutput ? (
        <Bubble role="assistant" text={turn.assistantOutput} />
      ) : (
        <p className="pl-9 text-sm text-muted-foreground italic">
          No output captured.
        </p>
      )}
    </div>
  );
}

function Bubble({
  role,
  text,
  raw,
}: {
  role: "user" | "assistant";
  text: string;
  raw?: string | null;
}) {
  const isUser = role === "user";
  const Icon = isUser ? IconUserFilled : IconGhostFilled;
  // Show the raw input disclosure only when it carries more than the extracted message.
  const showRaw = isUser && raw && raw.trim() !== text.trim();
  return (
    <div className="flex gap-3">
      <div
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full bg-muted-foreground/15 text-muted-foreground shadow-(--custom-shadow)",
          isUser && "mt-1.5",
        )}
      >
        <Icon className="size-3.5" />
      </div>
      <div
        className={
          isUser
            ? "min-w-0 flex-1 corner-squircle rounded-lg squircle:rounded-2xl bg-card px-3 py-2.5 shadow-(--custom-shadow) dark:bg-muted-foreground/10"
            : "min-w-0 flex-1 px-1 py-0"
        }
      >
        {isUser ? (
          <p className="whitespace-pre-wrap wrap-break-word text-sm">{text}</p>
        ) : (
          <div className="min-w-0 flex-1 text-sm leading-relaxed [&_li]:my-0.5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_pre]:my-2 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 *:last:mb-0 [&>*:first-child>*:first-child]:mt-0">
            <Streamdown
              components={markdownComponents}
              controls={{ table: false }}
            >
              {text}
            </Streamdown>
          </div>
        )}
        {showRaw && (
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">
              View full input
            </summary>
            <pre className="mt-1 overflow-auto whitespace-pre-wrap wrap-break-word rounded bg-background/60 p-2">
              {raw}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-4 w-80" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-xl border bg-card/40 p-4">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="mt-3 h-4 w-1/2" />
          <Skeleton className="mt-4 h-12 w-full" />
        </div>
      ))}
    </div>
  );
}
