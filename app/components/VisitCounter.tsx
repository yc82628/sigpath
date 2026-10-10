"use client";

import { Analytics } from "@vercel/analytics/next";
import { countedUrl } from "@/lib/visits";

/** Vercel Web Analytics, with each address cut down first (lib/visits.ts). No cookies. */
export default function VisitCounter() {
  return (
    <Analytics
      beforeSend={(event) => {
        const url = countedUrl(event.url);
        return url ? { ...event, url } : null;
      }}
    />
  );
}
