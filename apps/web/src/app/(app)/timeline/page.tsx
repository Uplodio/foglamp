import { Suspense } from "react";

import { TimelineHeader } from "./header";
import { TimelineClient } from "./timeline-client";

// Suspense because the client reads useSearchParams (the key/value pair).
// The fallback repeats loading.tsx's header so the handoff doesn't flash.
export default function TimelinePage() {
	return (
		<Suspense fallback={<TimelineHeader />}>
			<TimelineClient />
		</Suspense>
	);
}
