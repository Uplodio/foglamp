"use client";

import type { Route } from "next";

import { navItem } from "@/components/app/nav";
import { PageHeader } from "@/components/app/page-parts";
import { LiveRangePicker } from "@/components/app/route-header";

/** Shared between loading.tsx and timeline-client.tsx — see RouteHeader. The
 * breadcrumb leads back to Traces, carrying the metadata filter when known. */
export function TimelineHeader({
	backHref,
	description,
}: {
	backHref?: Route;
	description?: React.ReactNode;
}) {
	const traces = navItem("/traces");
	return (
		<PageHeader
			title="Timeline"
			back={traces ? { ...traces, href: backHref ?? traces.href } : undefined}
			description={description}
			actions={<LiveRangePicker />}
		/>
	);
}
