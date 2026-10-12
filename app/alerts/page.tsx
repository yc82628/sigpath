import Link from "next/link";
import { getMessages } from "@/lib/i18n/server";
import AlertsManager from "./AlertsManager";

export const dynamic = "force-dynamic";

export default function AlertsPage() {
  const m = getMessages();
  return (
    <main className="container">
      <h1>{m.alerts.title}</h1>
      <p className="lede">
        {m.alerts.lede}
      </p>
      <AlertsManager />
      <p className="hint" style={{ marginTop: 24 }}>
        {m.alerts.deleted}{" "}
        <Link href="/search">{m.alerts.back}</Link>
      </p>
    </main>
  );
}
