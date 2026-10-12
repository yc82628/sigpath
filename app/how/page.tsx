import Link from "next/link";
import PopIcon, { type Tone } from "../components/PopIcon";
import type { IconName } from "../components/icon-paths";
import { getMessages } from "@/lib/i18n/server";

const STEP_ICONS: { name: IconName; tone: Tone }[] = [
  { name: "shield-check", tone: "purple" },
  { name: "camera", tone: "blue" },
  { name: "gavel", tone: "green" },
  { name: "seal-check", tone: "purple" },
];

export const metadata = { title: "How SigPath keeps fakes out" };

export default function HowPage() {
  const m = getMessages();
  return (
    <main className="container wide how">
      <h1>{m.how.title}</h1>
      <ol className="steps">
        {m.how.steps.map((step, i) => (
          <li key={step.strong} className="with-icon">
            <PopIcon name={STEP_ICONS[i].name} tone={STEP_ICONS[i].tone} size={30} />
            <span>
              <strong>{step.strong}</strong> {step.text}
            </span>
          </li>
        ))}
      </ol>
      <h2 className="with-icon">
        <PopIcon name="vault" tone="blue" size={28} />
        {m.how.money}
      </h2>
      <p className="hint">{m.how.moneyText}</p>
      <p className="how-cta">
        <Link className="button" href="/">
          {m.how.start}
        </Link>{" "}
        <Link className="button ghost" href="/alerts">
          {m.how.alerts}
        </Link>
      </p>
    </main>
  );
}
