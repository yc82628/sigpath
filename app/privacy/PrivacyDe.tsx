import Link from "next/link";
import {
  aliexpressAffiliate,
  aliexpressOn,
  amazonTag,
  assistantProvider,
  assistantBackupProvider,
  hasCheckout,
  hasDatabase,
  hasPriceAlerts,
  hasReports,
  modelPhrase,
  operator,
  photoCheckProvider,
  solanaRpcProvider,
} from "@/lib/legal/site";
import { PENDING_TTL_SECONDS, RETENTION_MAX_SECONDS } from "@/lib/checkout/address-store";
import { REPORT_WINDOW_SECS } from "@/lib/reports/order-meta";
import { PENDING_REPORT_MAX_SECS } from "@/lib/reports/reports";
import { WATCH_TTL_SECS } from "@/lib/alerts/watches";
import { visitCounterOn } from "@/lib/visits";
import { BUSINESS_TTL_SECS } from "@/lib/sellers/business";
import PopIcon from "../components/PopIcon";
import OpenFromHash from "../components/OpenFromHash";
import { Part } from "./Part";

/**
 * app/privacy/PrivacyDe.tsx — the privacy policy in German (Datenschutzerklärung).
 *
 * The same policy as the English page (page.tsx), topic for topic: the same
 * features switched on or off by the same settings, the same providers, the
 * same retention periods from the same constants. A change to one belongs in
 * both. Not legal advice: have it reviewed.
 */

const days = (secs: number) => Math.round(secs / 86400);
const minutes = (secs: number) => Math.round(secs / 60);

/** lib/legal/site.ts writes its provider phrases in English. */
const modelDe = (provider: string) =>
  modelPhrase(provider).startsWith("an AI model on") ? "ein KI-Modell auf SigPaths eigenem Server" : `ein KI-Modell von ${provider}`;
const rpcDe = (s: string) =>
  s === "the Solana Foundation's public RPC service" ? "den öffentlichen RPC-Dienst der Solana Foundation" : s === "a Solana RPC service" ? "einen Solana-RPC-Dienst" : s;

export default function PrivacyDe() {
  const op = operator();
  const ai = assistantProvider();
  const aiBackup = assistantBackupProvider();
  const photos = photoCheckProvider();
  const checkout = hasCheckout();
  const alerts = hasPriceAlerts();
  const tag = amazonTag();
  const reports = hasReports();
  const counter = visitCounterOn();
  const ali = aliexpressOn();
  const storage = hasDatabase() ? "verschlüsselt in SigPaths Datenbank (Upstash)" : "verschlüsselt auf SigPaths Server";

  return (
    <main className="container legal">
      <h1>Datenschutzerklärung</h1>
      <p className="hint">Privacy policy</p>

      <p className="lede">Die Kurzfassung in Bildern. Tippe unten auf ein Thema für alle Einzelheiten.</p>
      <ul className="privacy-glance">
        <li>
          <PopIcon name="user-focus" tone="purple" size={28} />
          <strong>Kein Konto</strong>
          <span>Keine Anmeldung, nichts zu registrieren.</span>
        </li>
        <li>
          <PopIcon name="prohibit" tone="blue" size={28} />
          <strong>Kein Tracking</strong>
          <span>Keine Werbe- oder Tracking-Cookies.{counter ? " Besuche nur als Summen gezählt." : ""}</span>
        </li>
        <li>
          <PopIcon name="magnifying-glass" tone="green" size={28} />
          <strong>Suchen werden nicht gespeichert</strong>
          <span>An die Marktplätze gesendet, nie gespeichert.</span>
        </li>
        <li>
          <PopIcon name="shopping-cart-simple" tone="purple" size={28} />
          <strong>Warenkorb auf deinem Gerät</strong>
          <span>In deinem Browser, nicht auf unseren Servern.</span>
        </li>
        <li>
          <PopIcon name="lock-key" tone="blue" size={28} />
          <strong>Erweiterung: deine Wahl</strong>
          <span>Amazon-Preise teilen ist aus, bis du es einschaltest.</span>
        </li>
        {checkout && (
          <li>
            <PopIcon name="vault" tone="green" size={28} />
            <strong>Adresse verschlüsselt</strong>
            <span>Nur für deine Lieferung, danach gelöscht.</span>
          </li>
        )}
        <li>
          <PopIcon name="wallet" tone="purple" size={28} />
          <strong>Die Blockchain ist öffentlich</strong>
          <span>Eine Zahlung auf Solana bleibt für immer sichtbar.</span>
        </li>
        <li>
          <PopIcon name="trash" tone="blue" size={28} />
          <strong>Löschung nach Plan</strong>
          <span>Nur gespeichert, solange die Funktion es braucht.</span>
        </li>
      </ul>

      <h2 className="legal-full">Alle Einzelheiten</h2>
      <OpenFromHash />
      <Part title="Verantwortlicher">
        <p>
          {op ? (
            <>
              {op.name}, {op.address.join(", ")}. E-Mail: <a href={`mailto:${op.email}`}>{op.email}</a>.
            </>
          ) : (
            <>Der im <Link href="/impressum">Impressum</Link> genannte Anbieter.</>
          )}
        </p>
      </Part>

      <Part title="Besuch der Website">
        <p>
          SigPath wird von Vercel Inc., USA, gehostet. Um die Seiten auszuliefern und vor Missbrauch zu schützen, verarbeitet
          Vercel technische Daten wie deine IP-Adresse, die Uhrzeit und die aufgerufene Seite (Rechtsgrundlage: Art. 6 Abs. 1
          lit. f DSGVO, unser berechtigtes Interesse an einer sicheren, funktionierenden Website). Die Schriften der Website
          liefert SigPath selbst aus; dein Browser stellt also keine Anfrage an Google Fonts.
        </p>
        <p>
          Stellst du die Website auf Deutsch (oder zurück), merkt sich ein Cookie, <code>sigpath-lang</code>, die Wahl für ein
          Jahr. Es enthält nur &bdquo;de&ldquo; oder &bdquo;en&ldquo;, wird nur an SigPath gesendet und nur gesetzt, wenn du
          den Umschalter drückst (Rechtsgrundlage: § 25 Abs. 2 Nr. 2 TDDDG, von dir gewünschte Speicherung).
        </p>
        <p>
          Damit ein einzelnes Skript nicht die Suchen oder Prüfungen der Website für alle aufbraucht, zählt SigPath, wie viele
          Suchen und Anfragen in einem kurzen Zeitfenster von jeder Verbindung kommen (zehn Minuten; bei einigen Prüfungen
          eine Stunde oder ein Tag). Deine IP-Adresse wird dafür nicht gespeichert, nur ein mit einem Schlüssel gebildeter
          Hashwert davon, der sich ohne SigPaths geheimen Schlüssel nicht in die Adresse zurückrechnen lässt, neben einer
          Zahl. {hasDatabase() ? "Der Zähler liegt in SigPaths Datenbank (Upstash) und wird" : "Der Zähler wird"}{" "}
          automatisch gelöscht, wenn sein Zeitfenster endet (Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO, unser berechtigtes
          Interesse daran, die Website verfügbar zu halten).
        </p>
      </Part>
      {counter && (
        <>
          <Part title="Zählung der Besuche">
            <p>
              Um zu wissen, wie viele Menschen SigPath nutzen und woher sie kommen, zählt die Website Seitenaufrufe mit
              Vercel Web Analytics (Vercel Inc., USA). Dabei werden keine Cookies gesetzt. Bevor ein Seitenaufruf gesendet
              wird, wird seine Adresse auf die Art der Seite gekürzt: Suchbegriffe, Bestellnummern, Verkäufernamen und alles
              nach &bdquo;?&ldquo; werden entfernt. Zu jedem Seitenaufruf erfasst Vercel die Uhrzeit, diese Seitenart, die
              Website, von der du kamst (nur wenn es eine andere ist), deinen ungefähren Standort (Land, Region, Stadt) sowie
              Browser, Betriebssystem und Gerätetyp. Vercel unterscheidet Besucher anhand eines Hashwerts der Anfrage, den es
              nach 24 Stunden verwirft, und SigPath sieht nur Summen (Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO, unser
              berechtigtes Interesse daran, zu wissen, welche Seiten genutzt werden und wie Menschen die Website finden).
            </p>
          </Part>
        </>
      )}

      <Part title="Suchen">
        <p>
          Deine Suchbegriffe werden an die offizielle{ali ? "n" : ""} API{ali ? "s" : ""} von eBay{ali ? " und AliExpress" : ""}{" "}
          gesendet, um Angebote abzurufen. Dabei werden keine Angaben über dich mitgesendet, und SigPath speichert weder die
          Suche noch die Ergebnisse. Eine Preisprüfung (/check) sendet den Produktnamen und den Preis, die du mitbringst,
          sowie die Adresse der Seite, von der sie stammen, an SigPath zum Vergleich mit eBay; nichts davon wird gespeichert.
          Angebotsfotos werden von eBay{ali ? " und AliExpress" : ""} geladen, und einige von eBay werden auf Kopien
          verglichen.
        </p>
      </Part>
      <Part title="Die SigPath-Browsererweiterung" id="extension">
        <p>
          Die Erweiterung läuft von selbst nur auf Seiten von Amazon, AliExpress, OTTO, MediaMarkt und Saturn, die du öffnest,
          und auf der Seite eines anderen Shops nur, wenn du in ihrem Menü auf &bdquo;Diese Seite prüfen&ldquo; klickst. Auf
          einer Produktseite liest sie Namen und Preis des Produkts (bei Amazon auch Produktnummer, Fotoadresse und Namen des
          Verkäufers) und sendet sie mit der Adresse der Seite an SigPath, für dieselbe Prüfung wie /check. Nur wenn du
          &bdquo;Amazon.de-Preise teilen, die ich sehe&ldquo; einschaltest (ein Schalter im Menü der Erweiterung, aus, bis du
          es tust), speichert SigPath die Amazon-Produkte, die du angesehen hast, und die auf Amazon-Ergebnisseiten, die du
          öffnest: Produktnummer, Titel, Preis, Fotoadresse und Zeitpunkt, damit SigPaths Suche sie als &bdquo;auf Amazon
          gesehen&ldquo; zeigen kann. Nichts über dich wird mitgesendet oder gespeichert: kein Konto, keine Adresse, keine
          Aufzeichnung, wer was gesehen hat. Eine neuere Sichtung eines Produkts ersetzt die ältere, und Sichtungen, die älter
          als eine Woche sind, werden nicht angezeigt. Ist der Schalter aus, wird nichts geteilt; die Prüfung funktioniert
          trotzdem.
        </p>
      </Part>
      <Part title="Dein Warenkorb">
        <p>
          Der Warenkorb liegt nur in deinem Browser (in seinem lokalen Speicher), nicht auf SigPaths Servern, und es steht kein
          Konto dahinter. Er enthält, was die Suche zu jedem hinzugefügten Artikel zeigte: Titel, Link, Fotoadresse,
          Verkäufername, Preis und SigPaths Urteil. Öffnest du den Warenkorb, sendet dein Browser die Angebotsnummern der
          Artikel an SigPath, das bei eBay den heutigen Preis abfragt; davon wird nichts gespeichert. Artikel werden nach 30
          Tagen entfernt, und &bdquo;Warenkorb leeren&ldquo; oder das Löschen der Daten dieser Website entfernt sie sofort.
        </p>
      </Part>
      {ai && (
        <>
          <Part title="Ai-chan, die Einkaufsassistentin">
            <p>
              Wenn du mit Ai-chan chattest, werden deine Nachrichten an {modelDe(ai)} gesendet, um die Antwort zu schreiben
              {aiBackup && aiBackup !== ai && <>, oder, wenn dieses nicht verfügbar ist, an {modelDe(aiBackup)}</>}.
              SigPath speichert deine Chats nicht. Bitte teile darin keine persönlichen Daten (Rechtsgrundlage: Art. 6 Abs. 1
              lit. f DSGVO).
            </p>
          </Part>
        </>
      )}

      {checkout && (
        <>
          <Part title="Bezahlen mit USDC">
            <ul>
              <li>
                <strong>Deine Lieferadresse</strong> (Name, Straße, Postleitzahl, Ort, Land) wird {storage} gespeichert, nur
                für die Lieferung deines Artikels verwendet und an den Verkäufer weitergegeben, wenn SigPath den Artikel für
                dich kauft. Sie wird gelöscht, wenn die Bestellung erfüllt oder erstattet ist, nach{" "}
                {minutes(PENDING_TTL_SECONDS)} Minuten, wenn du nicht bezahlst, und in jedem Fall innerhalb von{" "}
                {days(RETENTION_MAX_SECONDS)} Tagen.
              </li>
              <li>
                <strong>Ein Bestelldatensatz</strong> (das Angebot, der Preis und deine Wallet-Adresse) wird nach der
                Lieferung {days(REPORT_WINDOW_SECS)} Tage aufbewahrt, damit du eine Fälschung melden kannst, und dann gelöscht.
              </li>
              <li>
                <strong>Deine Zahlung</strong> ist eine Solana-Transaktion. Deine Wallet-Adresse und die Zahlung sind auf der
                Blockchain öffentlich und können nicht gelöscht werden.
              </li>
            </ul>
            <p className="hint">Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO, zur Durchführung deines Kaufs.</p>
          </Part>
        </>
      )}

      {reports && (
        <>
          <Part title="Eine Fälschung melden">
            <p>
              Eine Meldung braucht deine Beschreibung, ein Live-Foto des Artikels und eine Signatur der Wallet, die bezahlt
              hat. Sie werden für die prüfende Person verschlüsselt gespeichert und gelöscht, sobald über die Meldung
              entschieden ist, in jedem Fall nach {days(PENDING_REPORT_MAX_SECS)} Tagen.
              {photos ? ` Das Foto wird von ${modelDe(photos)} geprüft.` : ""} Wird die Meldung bestätigt, wird ein Befund über
              den Verkäufer auf Solana veröffentlicht: Er enthält nichts über dich, weder deine Wallet noch deine Worte oder
              dein Foto.
            </p>
          </Part>
        </>
      )}

      <Part title="Verifizierte Verkäufer und Unternehmen">
        <ul>
          <li>
            <strong>Verkäufer-Abzeichen:</strong> SigPath speichert den Namen deines Marktplatzkontos, deine Wallet-Adresse und
            die Daten des Abzeichens. Das Live-Foto wird{photos ? ` von ${modelDe(photos)}` : ""} geprüft und dann verworfen:
            Es werden keine Bilder oder Gesichtsdaten gespeichert. Das Abzeichen ist ein Token in deiner Wallet und ein
            Datensatz auf Solana, beides öffentlich; es gilt ein Jahr und wird vorzeitig beendet, wenn eine Fälschungsmeldung
            bestätigt wird.
          </li>
          <li>
            <strong>Verifiziertes Unternehmen:</strong> Deine USt-IdNr. wird über den VIES-Dienst der EU geprüft und deine
            Website über ihre Domain-Registry. SigPath speichert den Unternehmensdatensatz bis zu {days(BUSINESS_TTL_SECS)}{" "}
            Tage; auf Solana werden USt-IdNr. und Website nur als Einweg-Hashwerte gespeichert.
          </li>
          <li>Löschst du dein eBay-Konto, benachrichtigt eBay SigPath, und die zugehörigen Datensätze werden gelöscht.</li>
        </ul>
        <p className="hint">Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO, die von dir gewünschte Verifizierung.</p>
      </Part>
      <Part title="Einen Lieferanten prüfen">
        <p>
          Die USt-IdNr. und die Website, die du eingibst, werden für die Prüfung an den VIES-Dienst der EU und an
          Domain-Registries gesendet. Nichts wird gespeichert.
        </p>
      </Part>
      {alerts && (
        <>
          <Part title="Preisalarme">
            <p>
              Ein Alarm speichert die Push-Adresse deines Browsers, die Suche und deinen Zielpreis bis zu{" "}
              {days(WATCH_TTL_SECS)} Tage; du kannst ihn jederzeit löschen. Benachrichtigungen erreichen dich über den
              Push-Dienst deines Browserherstellers (zum Beispiel Google, Mozilla oder Apple). Rechtsgrundlage: Art. 6 Abs. 1
              lit. a DSGVO, deine Einwilligung, die du widerrufen kannst, indem du den Alarm löschst.
            </p>
          </Part>
        </>
      )}

      <Part title="Die Solana-Blockchain">
        <p>
          Wallet-Transaktionen werden über {rpcDe(solanaRpcProvider())} gesendet. Was auf Solana geschrieben wird, ist
          öffentlich und dauerhaft: Niemand, auch SigPath nicht, kann es löschen. Deine Wallet-Adresse erscheint dort nur,
          wenn du bezahlst, ein Verkäufer-Abzeichen beantragst oder ein Unternehmen verifizierst.
        </p>
      </Part>
      {aliexpressAffiliate() && (
        <>
          <Part title="Links zu AliExpress">
            <p>
              Links zu AliExpress enthalten SigPaths Affiliate-Tracking-ID, und SigPath erhält eventuell eine Provision auf
              deinen Kauf. Sobald du auf AliExpress bist, gilt die Datenschutzerklärung von AliExpress, einschließlich seiner
              Cookies.
            </p>
          </Part>
        </>
      )}

      {tag && (
        <>
          <Part title="Links zu Amazon">
            <p>
              Links zu Amazon enthalten SigPaths Amazon-Partner-Tag. Als Amazon-Partner verdient SigPath an qualifizierten
              Verkäufen. Sobald du auf Amazon bist, gilt Amazons Datenschutzerklärung, einschließlich seiner Cookies.
            </p>
          </Part>
        </>
      )}

      <Part title="Anbieter außerhalb der EU">
        <p>
          Einige hier genannte Anbieter sitzen in den USA{ali ? ", und die API von AliExpress wird aus Singapur bereitgestellt" : ""};
          an sie gesendete Daten können daher dort verarbeitet werden.
        </p>
      </Part>
      <Part title="Deine Rechte">
        <p>
          Du kannst Auskunft über deine Daten, ihre Berichtigung oder Löschung, die Einschränkung ihrer Verarbeitung und eine
          Kopie verlangen und der Verarbeitung widersprechen (Art. 15–21 DSGVO). Daten auf der Blockchain kann niemand
          löschen. Du kannst dich außerdem bei einer Datenschutz-Aufsichtsbehörde beschweren. Um eines dieser Rechte
          auszuüben, schreib an die Adresse im <Link href="/impressum">Impressum</Link>.
        </p>
      </Part>
    </main>
  );
}
