"use client";

import { Badge } from "@foglamp/ui/components/badge";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@foglamp/ui/components/input-group";
import { Skeleton } from "@foglamp/ui/components/skeleton";
import { cn } from "@foglamp/ui/lib/utils";
import {
  IconAffiliateFilled,
  IconAlertTriangle,
  IconAlertTriangleFilled,
  IconArrowRight,
  IconBoltFilled,
  IconChevronRight,
  IconCoinFilled,
  IconMessage2Filled,
  IconSitemapFilled,
  IconTag,
  IconTagFilled,
  IconTimelineEvent,
  IconX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { Route } from "next";
import Link from "next/link";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { AgentIcon, agentColor } from "@/components/app/agent-icon";
import { ContextChip } from "@/components/app/context-chip";
import { CopyButton } from "@/components/app/copy-button";
import { CustomerAvatar } from "@/components/app/customer-avatar";
import {
  FilterSelect,
  Toolbar,
  useUrlFilters,
} from "@/components/app/data-table";
import {
  useDelayedLoading,
  useEntranceOnce,
  useSkeletonShown,
} from "@/components/app/hooks";
import { navItem } from "@/components/app/nav";
import {
  EmptyState,
  NoProject,
  PageHeader,
  type PageHeaderBack,
  StatCard,
} from "@/components/app/page-parts";
import { useProject } from "@/components/app/project-context";
import { useRange } from "@/components/app/range-context";
import { RangeControl } from "@/components/app/range-picker";
import { spanTypeBar } from "@/components/app/span-type";
import { SpanIconChip } from "@/components/app/trace-timeline";
import { formatModelName, modelBrandColor } from "@/components/model-logo";
import {
  formatCost,
  formatCostFixed,
  formatCount,
  formatDateTime,
  formatSpanDuration,
  formatTokens,
} from "@/lib/format";
import { toMs } from "@/lib/trace-timeline";
import { type RouterOutputs, trpc } from "@/utils/trpc";
import {
  computeSubtreeStats,
  DetailPanel,
} from "../traces/[traceId]/trace-detail-client";
import { TimelineHeader } from "./header";

type Timeline = RouterOutputs["traces"]["timeline"];
type Run = Timeline["runs"][number];
type Step = Run["steps"][number];

// Metadata-key option identity — the fuchsia tag the traces list uses for
// metadata values, so the picker reads as the same thing.
const MetaKeyIcon = (p: { className?: string }) => (
  <IconTagFilled className={cn(p.className, "text-fuchsia-500")} />
);

// The last key the person followed, so the picker opens where they left it.
// Browser storage is a convenience only: it can be empty or throw (private
// windows, cleared data), and the URL always wins.
const LAST_KEY = "foglamp:timeline:key";
function readLastKey(): string {
  try {
    return window.localStorage.getItem(LAST_KEY) ?? "";
  } catch {
    return "";
  }
}
function rememberKey(key: string): void {
  try {
    if (key) window.localStorage.setItem(LAST_KEY, key);
  } catch {
    /* storage unavailable — the URL still carries the key */
  }
}

// Same row grid as the trace waterfall, so a run reads like a trace: name |
// bar track | duration. The container query is set on the tree's wrapper.
const ROW_GRID =
  "grid grid-cols-[9.5rem_minmax(0,1fr)_3.25rem] @lg:grid-cols-[15rem_minmax(0,1fr)_6.5rem]";

// Runs that start expanded: a short story opens whole, a long one opens on
// its latest runs (the older ones are one click away).
const OPEN_ALL_UP_TO = 4;
const OPEN_LATEST = 3;

function runKey(r: Run): string {
  return `${r.kind}:${r.runId}`;
}

/**
 * "What happened to X": every trace carrying one metadata value, told as one
 * tree — each run (a session, a workflow run, or a lone trace) is a group of
 * its model calls and tool calls on run-relative timing bars — with the trace
 * page's own inspector on the right. Pick the key, paste the value, click a
 * row (or walk with ↑/↓) to read its input, output, tokens and cost in place.
 */
export function TimelineClient() {
  const entrance = useEntranceOnce();
  const { projectId } = useProject();
  const { range, setRange } = useRange();
  // The story's address lives in the URL so it survives reload and can be
  // shared; `span` is the row open in the inspector.
  const [params, patchParams] = useUrlFilters({ key: "", value: "", span: "" });
  const key = params.key;
  const value = params.value;
  const ready = !!key && !!value;

  // The key picker's options — every metadata key seen in the window.
  const metaKeys = useQuery({
    ...trpc.traces.metadataKeys.queryOptions({
      projectId: projectId!,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    }),
    enabled: !!projectId,
    placeholderData: (prev) => prev,
  });
  const metaKeyOptions = (metaKeys.data ?? []).map((k) => ({
    value: k,
    label: k,
    icon: MetaKeyIcon,
  }));
  // No key in the URL: open on the one last followed, else the commonest.
  useEffect(() => {
    if (key || !metaKeys.data?.length) return;
    const last = readLastKey();
    const pick = metaKeys.data.includes(last) ? last : metaKeys.data[0];
    if (pick) patchParams({ key: pick });
  }, [key, metaKeys.data, patchParams]);

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
  const data = timeline.data;
  const runs = useMemo(() => data?.runs ?? [], [data]);
  const stats = data?.stats;

  // Which runs are unfolded. Seeded once per story (see below); afterwards
  // the reader owns it.
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string> | null>(null);
  const toggleRun = useCallback(
    (k: string) =>
      setOpenRuns((prev) => {
        const next = new Set(prev ?? []);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        return next;
      }),
    [],
  );

  const selected = params.span;
  const select = useCallback(
    (spanId: string) => patchParams({ span: spanId }),
    [patchParams],
  );

  // A new story: seed the open runs and the selection — the `?span=` row's
  // run if the link names one, else the latest run's last model call (what
  // the story ended on).
  const storyKey = `${key}\u0000${value}`;
  const [seededFor, setSeededFor] = useState<string | null>(null);
  useEffect(() => {
    if (!data || runs.length === 0 || seededFor === storyKey) return;
    setSeededFor(storyKey);
    const open = new Set(
      (runs.length <= OPEN_ALL_UP_TO ? runs : runs.slice(-OPEN_LATEST)).map(
        runKey,
      ),
    );
    const linked = selected
      ? runs.find((r) => r.steps.some((s) => s.spanId === selected))
      : undefined;
    if (linked) {
      open.add(runKey(linked));
    } else {
      const last = runs[runs.length - 1];
      const llm = [...last.steps].reverse().find((s) => s.spanType === "llm");
      const pick = llm ?? last.steps[last.steps.length - 1];
      if (pick) select(pick.spanId);
    }
    setOpenRuns(open);
  }, [data, runs, seededFor, storyKey, selected, select]);

  // The visible rows in visual order — what ↑/↓ and the inspector's
  // previous/next walk, across runs.
  const visible = useMemo(() => {
    const out: Step[] = [];
    for (const r of runs) if (openRuns?.has(runKey(r))) out.push(...r.steps);
    return out;
  }, [runs, openRuns]);
  const selectedIndex = visible.findIndex((s) => s.spanId === selected);
  const selectedStep =
    selectedIndex >= 0
      ? visible[selectedIndex]
      : runs.flatMap((r) => r.steps).find((s) => s.spanId === selected);

  const stepSelection = useCallback(
    (delta: number) => {
      if (visible.length === 0) return;
      const i = visible.findIndex((s) => s.spanId === selected);
      const ni = i < 0 ? 0 : Math.max(0, Math.min(visible.length - 1, i + delta));
      select(visible[ni].spanId);
      document
        .getElementById(`step-${visible[ni].spanId}`)
        ?.scrollIntoView({ block: "nearest" });
    },
    [visible, selected, select],
  );
  // ↑/↓ or j/k walk the rows, like the trace page. Ignored while typing so
  // the paste box and payloads keep their keys.
  useEffect(() => {
    if (visible.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const next = e.key === "ArrowDown" || e.key === "j";
      const prev = e.key === "ArrowUp" || e.key === "k";
      if (!next && !prev) return;
      e.preventDefault();
      stepSelection(next ? 1 : -1);
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [visible.length, stepSelection]);

  // The selected row's trace, with payloads — the inspector's data. Cached
  // per trace, so walking a run's rows refetches only at trace boundaries.
  const traceId = selectedStep?.traceId ?? null;
  const detail = useQuery({
    ...trpc.traces.get.queryOptions({
      projectId: projectId!,
      traceId: traceId ?? "",
    }),
    enabled: !!projectId && !!traceId,
    placeholderData: (prev) => prev,
  });
  const traceSpans = useMemo(
    () => (detail.data?.traceId === traceId ? detail.data.spans : []) ?? [],
    [detail.data, traceId],
  );
  const activeSpan = traceSpans.find((s) => s.spanId === selected) ?? null;
  const subtreeStats = useMemo(
    () => computeSubtreeStats(traceSpans),
    [traceSpans],
  );
  const emptyMap = useMemo(() => new Map(), []);

  // Whether the tree outgrows the viewport — the inspector may then use more
  // height (same rule as the trace page).
  const [treeEl, setTreeEl] = useState<HTMLDivElement | null>(null);
  const [tall, setTall] = useState(false);
  useEffect(() => {
    if (!treeEl) return;
    const check = () =>
      setTall(treeEl.offsetHeight > globalThis.innerHeight - 14 * 16);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(treeEl);
    return () => observer.disconnect();
  }, [treeEl]);

  // Delay the skeleton so fast loads don't flash it (see useDelayedLoading).
  const showSkeleton = useDelayedLoading(ready && timeline.isLoading);
  const skeletonShown = useSkeletonShown(showSkeleton);

  // Follow a value: a new story, the inspector cleared until it seeds.
  const follow = (next: string) => {
    const v = next.trim();
    if (!v || !key) return;
    rememberKey(key);
    patchParams({ value: v, span: "" });
  };

  const section = navItem("/timeline");
  const back: PageHeaderBack | undefined = section
    ? { ...section, href: `/timeline?key=${encodeURIComponent(key)}` as Route }
    : undefined;

  // Landing: the section header. Loaded: the value as the title with a crumb
  // back to the landing, like a session page.
  const header = (
    <div className={cn(entrance && "page-fade-in")}>
      {ready ? (
        <PageHeader
          title={value}
          back={back}
          titleTrailing={<CopyButton value={value} title="Copy value" />}
        />
      ) : (
        <TimelineHeader />
      )}
    </div>
  );

  if (!projectId) {
    return (
      <>
        {header}
        <NoProject />
      </>
    );
  }

  // The toolbar always renders so the key, the paste box and the range stay
  // reachable — an empty range needs the range picker to escape.
  const toolbar = (
    <div className={cn("mt-1 flex flex-col gap-4", entrance && "page-fade-in")}>
      <Toolbar trailing={<RangeControl value={range} onChange={setRange} />}>
        <FilterSelect
          value={key}
          onChange={(v) => {
            rememberKey(v);
            patchParams({ key: v, value: "", span: "" });
          }}
          allLabel="Metadata key"
          icon={IconTag}
          options={metaKeyOptions}
        />
        <ValueInput
          key={key}
          disabled={!key}
          placeholder={key ? `Paste a ${key} and press Enter` : "Pick a key first"}
          initial={value}
          onSubmit={follow}
        />
      </Toolbar>
    </div>
  );

  if (!ready) {
    return (
      <>
        {header}
        {toolbar}
        <div className={cn("px-8", entrance && "page-fade-in")}>
          <EmptyState
            icon={IconTimelineEvent}
            title="Follow one value through every run"
            description={
              key
                ? `Paste a ${key} above and press Enter to see every run that touched it, oldest first.`
                : "Pick a metadata key above, then paste a value to see every run that touched it, oldest first."
            }
          />
        </div>
      </>
    );
  }

  const noRuns = !timeline.isLoading && runs.length === 0;

  return (
    <>
      {header}
      {toolbar}

      {/* Context chips: the key this value lives under (to the filtered
          traces list), the customer it belongs to, and the agents that
          touched it — the same linked-entity pills as the session page. */}
      {(data?.customer || runs.length > 0) && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 px-6 text-xs",
            entrance && !skeletonShown && "page-fade-in",
          )}
        >
          <ContextChip
            href={`/traces?metaKey=${encodeURIComponent(key)}&metaValue=${encodeURIComponent(value)}`}
            icon={IconTagFilled}
            iconClassName="text-fuchsia-500"
            label={key}
          />
          {data?.customer && (
            <ContextChip
              href={`/traces?customer=${encodeURIComponent(data.customer.customerId)}`}
              icon={(p) => (
                <CustomerAvatar
                  customerId={data.customer!.customerId}
                  customerName={data.customer!.customerName}
                  imageUrl={data.customer!.customerImageUrl}
                  filled
                  className={p.className}
                />
              )}
              iconClassName=""
              label={data.customer.customerName ?? data.customer.customerId}
            />
          )}
          {agentsOf(runs).map((name) => (
            <ContextChip
              key={name}
              href={`/agents/${encodeURIComponent(name)}`}
              icon={(p) => <AgentIcon name={name} filled className={p.className} />}
              iconClassName=""
              label={name}
            />
          ))}
        </div>
      )}

      {noRuns ? (
        <div className={cn(entrance && "page-fade-in", "px-8")}>
          <EmptyState
            icon={IconTimelineEvent}
            title="No traces in this range"
            description={`Nothing carries ${key} = ${value} in the selected window — try widening the time range.`}
          />
        </div>
      ) : (
        <>
          {/* Stat strip — totals over every run in the window. */}
          <section
            className={cn(
              "grid grid-cols-2 gap-4 px-8 md:grid-cols-4",
              entrance && "page-fade-in",
            )}
          >
            <StatCard
              icon={IconCoinFilled}
              iconClassName="text-amber-400 dark:text-yellow-500"
              size="sm"
              label="Total cost"
              value={stats?.totalCost ?? "—"}
              formatValue={(n) => formatCostFixed(n, 4)}
              hint={`${formatTokens(stats?.totalTokens ?? 0)} tokens`}
              loading={timeline.isLoading}
              skeleton={showSkeleton}
            />
            <StatCard
              icon={IconBoltFilled}
              iconClassName="text-orange-500 dark:text-orange-500"
              size="sm"
              label="Runs"
              value={stats?.runCount ?? 0}
              formatValue={formatCount}
              hint={`${formatCount(stats?.erroredRunCount ?? 0)} errored`}
              loading={timeline.isLoading}
              skeleton={showSkeleton}
            />
            <StatCard
              icon={IconAffiliateFilled}
              iconClassName="text-[#8b5e34] dark:text-[#c9a888]"
              size="sm"
              label="Traces"
              value={stats?.traceCount ?? 0}
              formatValue={formatCount}
              hint={`over ${formatSpanDuration(stats?.spanMs ?? 0)}`}
              loading={timeline.isLoading}
              skeleton={showSkeleton}
            />
            <StatCard
              icon={IconAlertTriangleFilled}
              iconClassName="text-red-500/90 dark:text-red-600/95 mt-px"
              size="sm"
              label="Errors"
              value={stats?.errorCount ?? 0}
              formatValue={formatCount}
              hint={`${formatCount(stats?.erroredRunCount ?? 0)} runs`}
              loading={timeline.isLoading}
              skeleton={showSkeleton}
            />
          </section>

          {data?.truncated && (
            <div className={cn("px-8", entrance && "page-fade-in")}>
              <Badge variant="amber" className="font-sans">
                <IconAlertTriangle />
                Showing the first 300 traces — narrow the range to see the rest
              </Badge>
            </div>
          )}

          {/* The story: the run tree on the left, the trace page's inspector
              on the right — the same split as a trace, across every run. */}
          <div
            className={cn(
              "mt-2 flex items-start gap-6 px-8 pb-8",
              entrance && !skeletonShown && "page-fade-in",
            )}
          >
            <div ref={setTreeEl} className="@container min-w-0 flex-1">
              {timeline.isLoading ? (
                showSkeleton ? (
                  <TreeSkeleton />
                ) : null
              ) : (
                <div className="flex flex-col gap-1">
                  {runs.map((r) => (
                    <RunGroup
                      key={runKey(r)}
                      run={r}
                      open={!!openRuns?.has(runKey(r))}
                      onToggle={() => toggleRun(runKey(r))}
                      selected={selected}
                      onSelect={select}
                    />
                  ))}
                </div>
              )}
            </div>
            {activeSpan ? (
              <DetailPanel
                span={activeSpan}
                scores={[]}
                trace={null}
                spans={traceSpans}
                evalMeta={emptyMap}
                presetName={emptyMap}
                spanIndex={selectedIndex}
                spanCount={visible.length}
                onStep={stepSelection}
                subtreeStats={subtreeStats}
                rank={null}
                tall={tall}
              />
            ) : (
              <InspectorSkeleton
                message={
                  selectedStep || detail.isLoading
                    ? null
                    : "Pick a row to read its input and output."
                }
              />
            )}
          </div>
        </>
      )}
    </>
  );
}

/** One run as a foldable group: a header row (agent, workflow, when, size,
 * cost) and, unfolded, its model and tool calls on bars scaled to the run. */
function RunGroup({
  run,
  open,
  onToggle,
  selected,
  onSelect,
}: {
  run: Run;
  open: boolean;
  onToggle: () => void;
  selected: string;
  onSelect: (spanId: string) => void;
}) {
  const startMs = run.steps.length
    ? Math.min(...run.steps.map((s) => toMs(s.startTime)))
    : toMs(run.startTime);
  const endMs = run.steps.length
    ? Math.max(...run.steps.map((s) => toMs(s.startTime) + s.durationMs))
    : toMs(run.endTime);
  const total = Math.max(1, endMs - startMs);
  const color = agentColor(run.agentName);
  return (
    <div className="flex flex-col">
      {/* Run header — the group row. Same height and grid as the step rows so
          the duration column lines up down the whole tree. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          ROW_GRID,
          "min-h-11 cursor-pointer items-center rounded-md py-1 text-left text-xs hover:bg-accent/80 @lg:text-sm dark:hover:bg-accent/50",
        )}
      >
        <div className="flex min-w-0 items-center gap-2 pr-3">
          <IconChevronRight
            className={cn(
              "size-3 shrink-0 text-muted-foreground/60 transition-transform",
              open && "rotate-90",
            )}
          />
          <span
            className="flex size-4.5 shrink-0 items-center justify-center rounded-md corner-squircle"
            style={{ backgroundColor: `${color}26` } as CSSProperties}
          >
            <AgentIcon name={run.agentName} className="size-3" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium">
              {run.workflowName ?? run.agentName ?? "Run"}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              {formatDateTime(run.startTime)}
            </span>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <AgentIcon name={run.agentName} className="size-3" />
            {run.agentName ?? "—"}
          </span>
          <span>·</span>
          <span className="tabular-nums">
            {formatCount(run.steps.length)}{" "}
            {run.steps.length === 1 ? "step" : "steps"}
          </span>
          <span>·</span>
          <span className="tabular-nums">{formatCost(run.totalCost)}</span>
          {run.errorCount > 0 && (
            <Badge variant="rose" className="shrink-0 gap-1 font-sans">
              <IconAlertTriangle className="size-3" />
              {run.errorCount}
            </Badge>
          )}
          <span className="ml-auto hidden items-center gap-1 @lg:flex">
            {run.sessionId && (
              <Link
                href={`/sessions/${encodeURIComponent(run.sessionId)}`}
                onClick={(e) => e.stopPropagation()}
                title="Open the session"
                className="inline-flex items-center rounded-md p-1 hover:bg-muted hover:text-foreground"
              >
                <IconMessage2Filled className="size-3.5 text-sky-500" />
              </Link>
            )}
            {run.workflowName && run.workflowRunId && (
              <Link
                href={
                  `/workflows/${encodeURIComponent(run.workflowName)}?run=${encodeURIComponent(run.workflowRunId)}` as Route
                }
                onClick={(e) => e.stopPropagation()}
                title="Open the workflow run"
                className="inline-flex items-center rounded-md p-1 hover:bg-muted hover:text-foreground"
              >
                <IconSitemapFilled className="size-3.5 text-emerald-500" />
              </Link>
            )}
          </span>
        </div>
        <span className="text-right text-xs text-muted-foreground tabular-nums @lg:text-sm">
          {formatSpanDuration(run.durationMs)}
        </span>
      </button>

      {open && (
        <div className="flex flex-col">
          {run.steps.length === 0 ? (
            <p className="py-2 pl-9 text-xs text-muted-foreground italic">
              No model or tool calls recorded for this run.
            </p>
          ) : (
            run.steps.map((s) => (
              <StepRow
                key={s.spanId}
                step={s}
                runStartMs={startMs}
                totalMs={total}
                selected={s.spanId === selected}
                onSelect={() => onSelect(s.spanId)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** One model call or tool call — the trace waterfall's row, with its bar
 * placed on the run's own clock. */
function StepRow({
  step,
  runStartMs,
  totalMs,
  selected,
  onSelect,
}: {
  step: Step;
  runStartMs: number;
  totalMs: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const isError = step.status === "error";
  const isAborted = step.status === "aborted";
  const offset = ((toMs(step.startTime) - runStartMs) / totalMs) * 100;
  const width = Math.max(0.6, (step.durationMs / totalMs) * 100);
  const accent =
    step.spanType === "llm"
      ? modelBrandColor(step.provider, step.modelId)
      : null;
  const barClass = isError
    ? "bg-rose-500"
    : isAborted
      ? "bg-amber-500"
      : accent
        ? undefined
        : spanTypeBar(step.spanType);
  const label =
    step.spanType === "llm"
      ? step.modelId
        ? formatModelName(step.modelId)
        : step.name
      : step.name;
  return (
    <button
      id={`step-${step.spanId}`}
      type="button"
      onClick={onSelect}
      className={cn(
        ROW_GRID,
        "min-h-10 cursor-pointer items-center rounded-md py-1 text-left text-xs @lg:text-sm",
        selected
          ? "bg-accent dark:bg-accent/70"
          : "hover:bg-accent/80 dark:hover:bg-accent/50",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 pr-3 pl-7">
        <SpanIconChip
          span={{
            name: step.name,
            spanType: step.spanType,
            provider: step.provider,
            modelId: step.modelId,
          }}
        />
        <span
          className={cn("truncate", step.spanType === "tool" && "font-mono")}
          title={step.name}
        >
          {label}
        </span>
        {isError && (
          <Badge variant="rose" className="shrink-0 gap-1">
            <IconAlertTriangle className="size-3" />
            error
          </Badge>
        )}
      </div>
      <div className="relative h-5">
        <div
          className={cn(
            "absolute top-1/2 h-2 -translate-y-1/2 rounded-xs",
            barClass,
          )}
          style={{
            left: `${Math.min(offset, 99.4)}%`,
            width: `${Math.min(width, 100 - Math.min(offset, 99.4))}%`,
            ...(barClass ? {} : { backgroundColor: accent ?? undefined }),
          }}
          title={`${label} · ${formatSpanDuration(step.durationMs)}${
            step.totalCost != null ? ` · ${formatCost(step.totalCost)}` : ""
          }`}
        />
      </div>
      <span className="text-right text-muted-foreground tabular-nums">
        {formatSpanDuration(step.durationMs)}
      </span>
    </button>
  );
}

function TreeSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1].map((g) => (
        <div key={g} className="flex flex-col gap-2">
          <Skeleton className="h-9 w-2/3" />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={cn(ROW_GRID, "items-center gap-2 pl-7")}>
              <Skeleton className="h-4 w-28" />
              <Skeleton
                className="h-2"
                style={{ marginLeft: `${i * 18}%`, width: "22%" }}
              />
              <Skeleton className="ml-auto h-4 w-10" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Stand-in for the inspector while the selected row's trace loads (same
 * width and chrome as the real panel, so nothing shifts when it lands). */
function InspectorSkeleton({ message }: { message: string | null }) {
  return (
    <aside className="sticky top-4 w-[420px] shrink-0 self-start">
      <div className="flex flex-col gap-4 corner-squircle rounded-lg bg-card p-5 shadow-(--custom-shadow) squircle:rounded-3xl">
        {message ? (
          <p className="text-sm text-muted-foreground">{message}</p>
        ) : (
          <>
            <Skeleton className="h-5 w-40" />
            <div className="grid grid-cols-2 gap-4">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
            <Skeleton className="h-40" />
          </>
        )}
      </div>
    </aside>
  );
}

/** Every agent any run touched, in first-seen order. */
function agentsOf(runs: Run[]): string[] {
  const out: string[] = [];
  for (const r of runs) for (const a of r.agents) if (!out.includes(a)) out.push(a);
  return out;
}

/** The paste box: a value typed or pasted here opens its timeline on Enter,
 * on the arrow button, or straight away on paste (an id pasted from the
 * dashboard is the whole input). Styled as the Traces search pill so it
 * sits next to the key picker as one toolbar. Remounted per key (`key=`),
 * so switching keys clears a half-typed value. */
function ValueInput({
  initial,
  placeholder,
  disabled,
  onSubmit,
}: {
  initial: string;
  placeholder: string;
  disabled: boolean;
  onSubmit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  // A story opened elsewhere (a Traces "Timeline" button, a back navigation)
  // lands in the box too.
  useEffect(() => setDraft(initial), [initial]);
  const submit = () => onSubmit(draft);
  return (
    <InputGroup
      className={cn(
        // Same surface as SearchInput: the outline-Button look, pill-shaped.
        "h-8 w-80 rounded-full squircle:rounded-full corner-round! shadow-(--custom-outline-shadow) dark:shadow-(--custom-outline-shadow) dark:border-0 bg-card dark:bg-card hover:bg-muted/50 dark:hover:bg-muted",
        disabled && "opacity-60",
      )}
    >
      <InputGroupAddon>
        <IconTag className="size-3.5 dark:text-[#5B5B5B] text-[#B8B8B8]" />
      </InputGroupAddon>
      <InputGroupInput
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="h-8 font-mono text-xs"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text").trim();
          if (!text || text.includes("\n")) return;
          e.preventDefault();
          setDraft(text);
          onSubmit(text);
        }}
      />
      {draft && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label="Clear value"
            onClick={() => setDraft("")}
            className="rounded-full text-muted-foreground/60 hover:text-foreground"
          >
            <IconX className="size-3.5" />
          </InputGroupButton>
          <InputGroupButton
            size="icon-xs"
            aria-label="Open timeline"
            title="Open timeline (Enter)"
            disabled={disabled || draft.trim() === initial}
            onClick={submit}
            className="rounded-full text-muted-foreground/60 hover:text-foreground"
          >
            <IconArrowRight className="size-3.5" />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

