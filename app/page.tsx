export default function Home() {
  return (
    <main className="container">
      <h1>SigPath</h1>
      <p className="lede">
        Attestations originate on Solana and mirror to Base. Solana is the source of
        truth; the Base record is portable evidence for EVM consumers.
      </p>
      <p className="hint">
        Base scaffold. Start in <code>lib/chains/</code>.
      </p>
    </main>
  );
}
