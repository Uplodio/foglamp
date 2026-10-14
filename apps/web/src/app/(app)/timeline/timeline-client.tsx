"use client";

import { Badge } from "@foglamp/ui/components/badge";
import { Button } from "@foglamp/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@foglamp/ui/components/table";
import { cn } from "@foglamp/ui/lib/utils";
import {
  IconAffiliateFilled,
  IconAlertTriangle,
  IconAlertTriangleFilled,
  IconArrowUpRight,
  IconBoltFilled,
  IconCoinFilled,
  IconHistory,
  IconSitemapFilled,
  IconTagFilled,
  IconTool,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { Route } from "next";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useEffect, useRef, useState } from "react";

import { AgentIcon } from "@/components/app/agent-icon";
import { DRAWER_BUTTON_CLASS } from "@/components/app/button-styles";
import { Chip, ContextChip } from "@/components/app/context-chip";
import { CopyButton } from "@/components/app/copy-button";
import { CustomerAvatar } from "@/components/app/customer-avatar";
import { useUrlFilters } from "@/components/app/data-table";
import { HeatCell } from "@/components/app/heat-cell";
import {
  useDelayedLoading,
  useEntranceOnce,
  useSkeletonShown,
} from "@/components/app/hooks";
import { navItem } from "@/components/app/nav";
import { type FlowNode, NodeFlow } from "@/components/app/node-flow";
import {
  EmptyState,
  NoProject,
  PageHeader,
  type PageHeaderBack,
  type SkeletonCol,
  StatCard,
  TableRowsSkeleton,
} from "@/components/app/page-parts";
import { useProject } from "@/components/app/project-context";
import { useRange } from "@/components/app/range-context";
import { RangeControl } from "@/components/app/range-picker";
import { RelativeTime } from "@/components/app/relative-time";
import {
  Conversation,
  CustomerValue,
  DrawerColumns,
  DrawerRow,
  ExpandChevron,
  FOCUSED_ROW_CLASS,
  Meta,
  MetaEmpty,
  ModelsValue,
  OPEN_ROW_CLASS,
  SessionButton,
} from "@/components/app/run-exchange";
import {
  formatCost,
  formatCostFixed,
  formatCount,
  formatDateTime,
  formatSpanDuration,
  formatTokens,
} from "@/lib/format";
import { type RouterOutputs, trpc } from "@/utils/trpc";

type Timeline = RouterOutputs["traces"]["timeline"];
type Run = Timeline["runs"][number];

// Mirrors the runs table's column widths so the skeleton→data swap can't
// shift the layout (Run | Traces | Duration | Cost | When).
const SKELETON_COLS: readonly SkeletonCol[] = [
  { w: "w-72", icon: true },
  { align: "right", w: "w-8" },
  { align: "right", w: "w-14" },
  { align: "right", w: "w-16" },
  { align: "right", w: "w-16" },
] as const;

/** 20/40/60/80th-percentile thresholds of the positive values (sorted-nearest)
 * — the heat shades for a column, computed over this timeline's runs. */
function quintiles(values: number[]): number[] {
  const xs = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (xs.length === 0) return [];
  return [0.2, 0.4, 0.6, 0.8].map((q) => {
    const idx = Math.min(xs.length - 1, Math.floor(q * (xs.length - 1)));
    return xs[idx] as number;
  });
}

/**
 * "What happened to X": every trace carrying one metadata value, folded into
 * runs (a session, a workflow run, or a lone trace) and told oldest first —
 * the workflow page's runs table, cut across sessions and workflows for one
 * record. Click a run for its overview, its tool steps, and its exchange.
 */
export function TimelineClient() {
  const entrance = useEntranceOnce();
  const { projectId } = useProject();
  const { range, setRange } = useRange();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [params] = useUrlFilters({ key: "", value: "" });
  const key = params.key;
  const value = params.value;
  const ready = !!key && !!value;

  // A `?run=` deep link focuses one run: its row opens and is tinted (same
  // mechanics as the workflow page).
  const focusRun = searchParams.get("run");
  const [expanded, setExpanded] = useState<string | null>(focusRun);
  const [deepLinked, setDeepLinked] = useState<string | null>(focusRun);
  const focusRef = useRef<HTMLTableRowElement>(null);

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
  const runs = data?.runs ?? [];
  const stats = data?.stats;

  // Reset the open drawer when the story changes (skipping mount, so a
  // deep-linked drawer survives the first render).
  const mounted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on query changes only
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setExpanded(null);
  }, [key, value, range, projectId]);

  const toggleRun = (id: string) => {
    const next = expanded === id ? null : id;
    setExpanded(next);
    setDeepLinked(null);
    const sp = new URLSearchParams(Array.from(searchParams.entries()));
    if (next) sp.set("run", next);
    else sp.delete("run");
    router.replace(`?${sp.toString()}`, { scroll: false });
  };
  // Once the deep-linked run is on the page, scroll it into view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run as runs load
  useEffect(() => {
    if (deepLinked && focusRef.current) {
      focusRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [deepLinked, timeline.data]);

  // Delay the skeleton so fast loads don't flash it (see useDelayedLoading).
  const showSkeleton = useDelayedLoading(ready && timeline.isLoading);
  const skeletonShown = useSkeletonShown(showSkeleton);

  const costQuantiles = quintiles(runs.map((r) => r.totalCost));
  const durationQuantiles = quintiles(runs.map((r) => r.durationMs));

  const tracesNav = navItem("/traces");
  const back: PageHeaderBack | undefined = tracesNav
    ? {
        ...tracesNav,
        href: (ready
          ? `/traces?metaKey=${encodeURIComponent(key)}&metaValue=${encodeURIComponent(value)}`
          : tracesNav.href) as Route,
      }
    : undefined;

  const header = (
    <div className={cn(entrance && "page-fade-in")}>
      <PageHeader
        title={ready ? value : "Timeline"}
        back={back}
        titleTrailing={
          ready ? <CopyButton value={value} title="Copy value" /> : undefined
        }
        actions={<RangeControl value={range} onChange={setRange} />}
      />
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

  if (!ready) {
    return (
      <>
        {header}
        <div className={cn("px-8", entrance && "page-fade-in")}>
          <EmptyState
            icon={IconHistory}
            title="Pick a metadata value"
            description="Open Traces, filter by a metadata key and value, then press Timeline."
          />
        </div>
      </>
    );
  }

  const noRuns = !timeline.isLoading && runs.length === 0;

  const renderRun = (r: Run) => {
    const rowKey = `${r.kind}:${r.runId}`;
    const isOpen = expanded === r.runId;
    const isFocused = r.runId === deepLinked;
    return (
      <Fragment key={rowKey}>
        <TableRow
          ref={isFocused ? focusRef : undefined}
          interactive
          aria-expanded={isOpen}
          onClick={() => toggleRun(r.runId)}
          className={cn(
            "group",
            isOpen && OPEN_ROW_CLASS,
            isFocused && FOCUSED_ROW_CLASS,
          )}
        >
          {/* Content-first: the run's opening user message, falling back to
              what it reported, then its id; the agents involved trail on the
              right. */}
          <TableCell className="h-12 font-normal">
            <div className="flex items-center gap-2">
              <ExpandChevron open={isOpen} />
              <span className="truncate">
                {r.openingMessage ?? r.outcome ?? (
                  <span className="font-mono text-xs text-muted-foreground">
                    {r.runId}
                  </span>
                )}
              </span>
              {r.errorCount > 0 && (
                <span
                  title={`${r.errorCount} ${r.errorCount === 1 ? "error" : "errors"}`}
                  className="flex shrink-0 items-center gap-0.75 font-sans text-sm text-red-600 dark:text-red-400"
                >
                  <IconAlertTriangle className="size-3.5 fill-current/20" />
                  {r.errorCount}
                </span>
              )}
              <AgentStack names={r.agents} />
            </div>
          </TableCell>
          <TableCell className="text-right tabular-nums">
            {formatCount(r.turns.length)}
          </TableCell>
          <HeatCell
            value={r.durationMs}
            thresholds={durationQuantiles}
            metric="duration"
          >
            {formatSpanDuration(r.durationMs)}
          </HeatCell>
          <HeatCell
            value={r.totalCost}
            thresholds={costQuantiles}
            metric="cost"
            bold
          >
            {formatCost(r.totalCost)}
          </HeatCell>
          <TableCell className="text-right text-muted-foreground">
            <RelativeTime value={r.startTime} />
          </TableCell>
        </TableRow>
        {isOpen && (
          <RunDrawer run={r} customer={data?.customer ?? null} colSpan={5} />
        )}
      </Fragment>
    );
  };

  return (
    <>
      {header}

      {/* Context chips: the key this value lives under (back to the filtered
          traces list), the customer it belongs to, and the agents that
          touched it — the same linked-entity pills as the session page. */}
      {(data?.customer || (data?.runs.length ?? 0) > 0) && (
        <div
          className={cn(
            "mt-1 flex flex-wrap items-center gap-2 px-6 text-xs",
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
            icon={IconHistory}
            title="No traces in this range"
            description={`Nothing carries ${key} = ${value} in the selected window — try widening the time range.`}
          />
        </div>
      ) : (
        <>
          {/* Stat strip — totals over every run in the window. */}
          <section
            className={cn(
              "mt-1 grid grid-cols-2 gap-4 px-8 md:grid-cols-4",
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

          {/* Runs table, oldest first — click a row to open its steps and exchange. */}
          <div
            className={cn(
              "mt-4 flex flex-col",
              entrance && !skeletonShown && "page-fade-in",
            )}
          >
            {/* pr-11 (not the default pr-9): the range picker lives in the
                page header here (px-8) rather than a toolbar (pr-6), so the
                last column needs 8px more to line up with its chevron the way
                the list pages do. */}
            <Table
              className="table-fixed [&_th:last-child]:pr-11 [&_td:last-child]:pr-11"
              stickyHeader
            >
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead className="w-24 text-right">Traces</TableHead>
                  <TableHead className="w-28 text-right">Duration</TableHead>
                  <TableHead className="w-28 text-right">Cost</TableHead>
                  <TableHead className="w-32 text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {timeline.isLoading ? (
                  showSkeleton ? (
                    <TableRowsSkeleton cols={SKELETON_COLS} />
                  ) : null
                ) : (
                  runs.map(renderRun)
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </>
  );
}

/** Every agent any run touched, in first-seen order. */
function agentsOf(runs: Run[]): string[] {
  const out: string[] = [];
  for (const r of runs) for (const a of r.agents) if (!out.includes(a)) out.push(a);
  return out;
}

/** The agents a run touched, in first-run order: a tight stack of their
 * tinted ghosts (up to four, then "+n"), each named on hover. Sits at the end
 * of the Run cell so the message text truncates before the agents do. */
function AgentStack({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  const shown = names.slice(0, 4);
  const rest = names.length - shown.length;
  return (
    <span
      className="ml-auto flex shrink-0 items-center gap-1 pl-2"
      title={names.join(" → ")}
    >
      {shown.map((n) => (
        <AgentIcon key={n} name={n} className="size-3.5" />
      ))}
      {rest > 0 && (
        <span className="text-xs text-muted-foreground tabular-nums">
          +{rest}
        </span>
      )}
    </span>
  );
}

/** Expanded row: the run's overview on the left (timing, size, cost, where it
 * lives), its tool steps as a flow and its exchange — the opening message to
 * the final answer — on the right, then the turns it took, each linking to
 * its trace. Everything comes with the timeline payload; nothing to fetch. */
function RunDrawer({
  run,
  customer,
  colSpan,
}: {
  run: Run;
  customer: Timeline["customer"];
  colSpan: number;
}) {
  const router = useRouter();
  // One node per tool call, in call order across the run's turns — the run's
  // shape (load_case → update_crm → hand_off). NodeFlow folds repeats to ×N.
  const nodes: FlowNode[] = run.turns.flatMap((t) =>
    t.toolCalls.map((tc) => ({
      id: `${t.traceId}:${tc.name}`,
      icon: (
        <IconTool
          className={cn(
            "fill-current stroke-1",
            tc.errorCount > 0 ? "text-current" : "text-blue-500",
          )}
        />
      ),
      label: tc.name,
      sublabel: t.agentName,
      status: tc.errorCount > 0 ? ("error" as const) : ("ok" as const),
      timestamp: t.startTime,
      durationMs: null,
    })),
  );
  const turnWord = run.turns.length === 1 ? "turn" : "turns";
  return (
    <DrawerRow colSpan={colSpan} className="pt-6">
      <DrawerColumns
        overview={
          <>
            {run.errorCount > 0 && (
              <div className="flex h-5 items-center">
                <Badge variant="rose" className="font-sans">
                  <IconAlertTriangle />
                  {formatCount(run.errorCount)}
                  {run.errorCount === 1 ? " error" : " errors"}
                </Badge>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <Meta label="Started" value={formatDateTime(run.startTime)} />
              <Meta label="Duration" value={formatSpanDuration(run.durationMs)} />
              <Meta label="Traces" value={formatCount(run.turns.length)} />
              <Meta label="Tokens" value={formatTokens(run.totalTokens)} />
              <Meta label="Cost" value={formatCost(run.totalCost, 4)} />
              <Meta
                label="Customer"
                value={
                  <CustomerValue
                    customerId={customer?.customerId ?? null}
                    customerName={customer?.customerName}
                    imageUrl={customer?.customerImageUrl}
                  />
                }
              />
              <Meta
                label="Agent"
                value={
                  run.agentName ? (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <AgentIcon name={run.agentName} className="size-3.5" />
                      <span className="truncate">{run.agentName}</span>
                    </span>
                  ) : (
                    <MetaEmpty />
                  )
                }
              />
              <Meta
                label="Workflow"
                value={
                  run.workflowName ? (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <IconSitemapFilled className="size-3.5 shrink-0 text-emerald-500" />
                      <span className="truncate">{run.workflowName}</span>
                    </span>
                  ) : (
                    <MetaEmpty />
                  )
                }
              />
              <Meta
                label={run.models.length === 1 ? "Model" : "Models"}
                className="col-span-2"
                value={<ModelsValue models={run.models} />}
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-2.5">
              <Button
                size="sm"
                variant="secondary"
                className={cn("w-fit", DRAWER_BUTTON_CLASS)}
                render={
                  // biome-ignore lint/suspicious/noExplicitAny: typed-routes string href
                  <Link href={`/traces/${encodeURIComponent(run.firstTraceId)}` as any} />
                }
              >
                <IconAffiliateFilled className="text-[#8b5e34] dark:text-[#c9a888]" />
                See first trace
                <IconArrowUpRight className="mt-px" />
              </Button>
              {run.sessionId && <SessionButton sessionId={run.sessionId} />}
              {run.workflowName && run.workflowRunId && (
                <Button
                  size="sm"
                  variant="secondary"
                  className={cn("w-fit", DRAWER_BUTTON_CLASS)}
                  render={
                    // biome-ignore lint/suspicious/noExplicitAny: typed-routes string href
                    <Link
                      href={
                        `/workflows/${encodeURIComponent(run.workflowName)}?run=${encodeURIComponent(run.workflowRunId)}` as any
                      }
                    />
                  }
                >
                  <IconSitemapFilled className="text-emerald-500" />
                  See workflow run
                  <IconArrowUpRight className="mt-px" />
                </Button>
              )}
            </div>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <DrawerSection label="Steps">
            {nodes.length === 0 ? (
              <span className="text-xs text-muted-foreground">
                No tool calls in this run.
              </span>
            ) : (
              <NodeFlow
                nodes={nodes}
                onNodeClick={(id) =>
                  router.push(
                    `/traces/${encodeURIComponent(id.slice(0, id.indexOf(":")))}`,
                  )
                }
              />
            )}
          </DrawerSection>
          <DrawerSection label="Exchange">
            {!run.openingInput && !run.outcome ? (
              <span className="text-xs text-muted-foreground">
                Trace payload unavailable.
              </span>
            ) : (
              <Conversation
                input={run.openingInput}
                output={run.outcome}
                emptyHint="The run ended without a text answer."
                clamp={320}
              />
            )}
          </DrawerSection>
          <DrawerSection label={`${formatCount(run.turns.length)} ${turnWord}`}>
            <ol className="flex flex-col gap-1.5">
              {run.turns.map((t, i) => (
                <li
                  key={t.traceId}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
                >
                  <Link
                    href={`/traces/${encodeURIComponent(t.traceId)}`}
                    className="inline-flex items-center gap-0.5 font-medium text-foreground tabular-nums transition-colors hover:underline underline-offset-2"
                  >
                    Turn {i + 1}
                    <IconArrowUpRight className="size-3" />
                  </Link>
                  {t.status === "error" && (
                    <span className="size-1.5 shrink-0 rounded-full bg-rose-500" />
                  )}
                  {t.status === "aborted" && (
                    <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
                  )}
                  <span>{formatDateTime(t.startTime)}</span>
                  <span>·</span>
                  <span className="tabular-nums">{formatSpanDuration(t.durationMs)}</span>
                  <span>·</span>
                  <span className="tabular-nums">{formatCost(t.totalCost)}</span>
                  {t.toolCalls.length > 0 && (
                    <span className="flex flex-wrap items-center gap-1">
                      {t.toolCalls.map((tc) => (
                        <Chip
                          key={tc.name}
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
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </DrawerSection>
        </div>
      </DrawerColumns>
    </DrawerRow>
  );
}

function DrawerSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
