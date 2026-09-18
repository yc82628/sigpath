"use client";

import { useState } from "react";
import CameraCapture from "../components/CameraCapture";

/**
 * Live capture, then attestation.
 *
 * The sessionId returned by a PASSING capture is handed to /api/attest, which
 * consumes it server-side to decide whether to set the on-chain LIVE_CAPTURE
 * flag. The browser never asserts that it passed — it only passes an id the
 * server issued and can look up.
 */
export default function CapturePage() {
  const [sessionId, setSessionId] = useState<string | null>(null);

  return (
    <main className="container">
      <h1>Live capture</h1>
      <p className="lede">
        A one-time instruction, 90 seconds, camera only. The window is short on
        purpose: the only thing an attacker must do after seeing the instruction is
        render an unpredictable code in convincing handwriting, and every extra
        second helps them rather than you.
      </p>

      <CameraCapture onComplete={setSessionId} />

      {sessionId && (
        <p className="hint" style={{ marginTop: 24 }}>
          Capture verified. Pass <code>{sessionId}</code> as{" "}
          <code>livenessSessionId</code> to <code>/api/attest</code> to record the
          on-chain <code>LIVE_CAPTURE</code> flag. It is single use.
        </p>
      )}
    </main>
  );
}
