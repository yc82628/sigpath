import Link from "next/link";
import AlertsManager from "./AlertsManager";

export const dynamic = "force-dynamic";

export default function AlertsPage() {
  return (
    <main className="container">
      <h1>Price alerts</h1>
      <p className="lede">
        Alerts in <strong>this browser</strong>. There&apos;s no account: each alert belongs to the browser that set it, and
        only fires for a SigPath-checked deal.
      </p>
      <AlertsManager />
      <p className="hint" style={{ marginTop: 24 }}>
        SigPath keeps each alert&apos;s search, target price and an anonymous browser address for 30 days, then deletes it.{" "}
        <Link href="/search">Back to search</Link>
      </p>
    </main>
  );
}
