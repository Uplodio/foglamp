"use client";

import { navItem } from "@/components/app/nav";
import { PageHeader } from "@/components/app/page-parts";
import { LiveRangePicker } from "@/components/app/route-header";

/** Rendered by loading.tsx and the Suspense fallback — see RouteHeader. The
 * page itself titles the header with the value once it has read the URL, so
 * this one is the breadcrumb shell with a placeholder title. */
export function TimelineHeader() {
	const traces = navItem("/traces");
	return (
		<PageHeader
			title="Timeline"
			back={traces}
			actions={<LiveRangePicker />}
		/>
	);
}
