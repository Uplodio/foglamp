"use client";

import { RouteHeader } from "@/components/app/route-header";

/** Shared between loading.tsx and timeline-client.tsx — see RouteHeader. A
 * loaded story retitles the header with its value and a crumb back here. */
export function TimelineHeader() {
	return <RouteHeader href="/timeline" title="Timeline" />;
}
