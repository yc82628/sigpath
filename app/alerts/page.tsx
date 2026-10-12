import Link from "next/link";
import AlertsManager from "./AlertsManager";

export const dynamic = "force-dynamic";

export default function AlertsPage() {
  return (
    <main className="container">
      <h1>Price alerts</h1>
      <p className="lede">
        Alerts in <strong>this browser</strong>, for SigPath-checked deals only.
      </p>
      <AlertsManager />
      <p className="hint" style={{ marginTop: 24 }}>
        Each alert is deleted after 30 days.{" "}
        <Link href="/search">Back to search</Link>
      </p>
    </main>
  );
}
