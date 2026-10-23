"use client";

import { Badge } from "@foglamp/ui/components/badge";
import { Button } from "@foglamp/ui/components/button";
import { Skeleton } from "@foglamp/ui/components/skeleton";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@foglamp/ui/components/input-group";
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
  IconArrowRight,
  IconArrowUpRight,
  IconChevronDown,
  IconChevronRight,
  IconBoltFilled,
  IconCoinFilled,
  IconSitemapFilled,
  IconTag,
  IconTagFilled,
  IconTimelineEvent,
  IconTool,
  IconX,
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
import { FilterSelect, Toolbar, useUrlFilters } from "@/components/app/data-table";
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
import { JsonBlock, Prose } from "@/components/app/payload-view";
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
import { TimelineHeader } from "./header";

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
 * record. Pick the key, paste the value, and click a run for its overview,
 * its tool steps, and its exchange.
 */
export function TimelineClient() {
  const entrance = useEntranceOnce();
  const { projectId } = useProject();
  const { range, setRange } = useRange();
  const router = useRouter();
  const searchParams = useSearchParams();
  // The story's address lives in the URL so it survives reload and can be
  // shared; `run` is the open drawer (see toggleRun).
  const [params, patchParams] = useUrlFilters({ key: "", value: "", run: "" });
  const key = params.key;
  const value = params.value;
  const ready = !!key && !!value;

  // A `?run=` deep link focuses one run: its row opens and is tinted (same
  // mechanics as the workflow page).
  const focusRun = searchParams.get("run");
  const [expanded, setExpanded] = useState<string | null>(focusRun);
  const [deepLinked, setDeepLinked] = useState<string | null>(focusRun);
  const focusRef = useRef<HTMLTableRowElement>(null);

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

  // Follow a value: a new story, with any open drawer left behind.
  const follow = (next: string) => {
    const v = next.trim();
    if (!v || !key) return;
    rememberKey(key);
    setExpanded(null);
    setDeepLinked(null);
    patchParams({ value: v, run: "" });
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
            setExpanded(null);
            setDeepLinked(null);
            patchParams({ key: v, value: "", run: "" });
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
      {toolbar}

      {/* Context chips: the key this value lives under (to the filtered
          traces list), the customer it belongs to, and the agents that
          touched it — the same linked-entity pills as the session page. */}
      {(data?.customer || (data?.runs.length ?? 0) > 0) && (
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

          {/* Runs table, oldest first — click a row to open its steps and exchange. */}
          <div
            className={cn(
              "mt-4 flex flex-col",
              entrance && !skeletonShown && "page-fade-in",
            )}
          >
            {/* pr-11 (not the default pr-9): the range picker lives in the
                toolbar's trailing group, which lifts into the header when
                space is tight, so the last column lines up with it the way
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
                  document
                    .getElementById(`tool-${id}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "center" })
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
            <ToolLog run={run} />
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

type ToolCall = RouterOutputs["traces"]["runToolCalls"][number];

/** A payload as the reader wants it: JSON pretty-printed, prose as markdown.
 * Tool payloads are serialized JSON almost always; an AI SDK tool output may
 * wrap the value as {type: "json"|"text", value}. */
function PayloadBlock({ raw }: { raw: string }) {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return (
      <div className="max-h-56 overflow-y-auto rounded-md bg-background/60 p-2">
        <Prose>{raw}</Prose>
      </div>
    );
  }
  if (data && typeof data === "object" && "type" in data && "value" in data) {
    const d = data as { type: unknown; value: unknown };
    if (d.type === "text" && typeof d.value === "string") {
      return (
        <div className="max-h-56 overflow-y-auto rounded-md bg-background/60 p-2">
          <Prose>{d.value}</Prose>
        </div>
      );
    }
    if (d.type === "json") data = d.value;
  }
  return <JsonBlock data={data} className="rounded-md bg-background/60" />;
}

/** The run told turn by turn, each tool call inline with its input and output
 * — no trip to the trace page. Fetched when the drawer opens; calls start
 * open, a click on the header folds one away. */
function ToolLog({ run }: { run: Run }) {
  const { projectId } = useProject();
  const calls = useQuery({
    ...trpc.traces.runToolCalls.queryOptions({
      projectId: projectId!,
      traceIds: run.turns.map((t) => t.traceId),
    }),
    enabled: !!projectId && run.turns.length > 0,
  });
  const byTrace = new Map<string, ToolCall[]>();
  for (const c of calls.data ?? []) {
    const list = byTrace.get(c.traceId) ?? [];
    list.push(c);
    byTrace.set(c.traceId, list);
  }
  return (
    <ol className="flex flex-col gap-4">
      {run.turns.map((t, i) => {
        const turnCalls = byTrace.get(t.traceId) ?? [];
        return (
          <li key={t.traceId} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <Link
                href={`/traces/${encodeURIComponent(t.traceId)}`}
                className="inline-flex items-center gap-0.5 font-medium text-foreground tabular-nums underline-offset-2 transition-colors hover:underline"
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
            </div>
            {calls.isLoading ? (
              t.toolCalls.length > 0 && (
                <div className="ml-3 flex flex-col gap-2 border-l border-border/60 pl-3">
                  {t.toolCalls.map((tc) => (
                    <Skeleton key={tc.name} className="h-7 w-48" />
                  ))}
                </div>
              )
            ) : turnCalls.length === 0 ? (
              <p className="ml-3 border-l border-border/60 pl-3 text-xs text-muted-foreground italic">
                No tool calls — the model answered.
              </p>
            ) : (
              <div className="ml-3 flex flex-col gap-2 border-l border-border/60 pl-3">
                {turnCalls.map((c) => (
                  <ToolCallBlock
                    key={c.spanId}
                    call={c}
                    anchor={`tool-${t.traceId}:${c.name}`}
                  />
                ))}
              </div>
            )}
          </li>
        );
      })}
      {calls.error && (
        <li className="text-xs text-muted-foreground">
          Couldn't load the tool calls: {calls.error.message}
        </li>
      )}
    </ol>
  );
}

function ToolCallBlock({ call, anchor }: { call: ToolCall; anchor: string }) {
  const [open, setOpen] = useState(true);
  const isError = call.status === "error";
  return (
    <div
      id={anchor}
      className={cn(
        "scroll-mt-24 corner-squircle rounded-lg bg-card shadow-(--custom-shadow) dark:bg-muted-foreground/10",
        isError && "ring-1 ring-rose-500/40",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs"
      >
        {open ? (
          <IconChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <IconChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <IconTool
          className={cn(
            "mb-px size-3.5 shrink-0 fill-current stroke-1",
            isError ? "text-rose-500" : "text-blue-500",
          )}
        />
        <span className="font-mono font-medium">{call.name}</span>
        {isError && (
          <Badge variant="rose" className="font-sans">
            <IconAlertTriangle />
            Error
          </Badge>
        )}
        <span className="ml-auto tabular-nums text-muted-foreground">
          {formatSpanDuration(call.durationMs)}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3 pb-3">
          {call.errorMessage && (
            <p className="text-xs text-rose-600 dark:text-rose-400">
              {call.errorMessage}
            </p>
          )}
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Input</span>
            {call.input ? (
              <PayloadBlock raw={call.input} />
            ) : (
              <span className="text-xs text-muted-foreground/60">—</span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Output</span>
            {call.output ? (
              <PayloadBlock raw={call.output} />
            ) : (
              <span className="text-xs text-muted-foreground/60">—</span>
            )}
          </div>
          {call.truncated && (
            <Link
              href={`/traces/${encodeURIComponent(call.traceId)}`}
              className="inline-flex w-fit items-center gap-0.5 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Payload cut at 16k characters — full version in the trace
              <IconArrowUpRight className="size-3" />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
