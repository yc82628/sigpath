"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { inspectStream, measureFrameJitter, toRiskBand, type RiskBand } from "@/lib/liveness/injection";

/**
 * Camera-only capture. There is deliberately NO `<input type="file">` anywhere
 * in this component — not hidden, not disabled, not behind a flag. The only way
 * a frame reaches the server is off a live `getUserMedia` stream.
 *
 * WHAT THAT DOES AND DOES NOT BUY — be honest about this in any pitch:
 *
 *   Stops:     someone with a saved deepfake who tries to upload it. That is the
 *              common case and it is worth stopping.
 *   Does NOT:  stop a virtual camera. `getUserMedia` cannot distinguish OBS
 *              Virtual Cam from a real sensor, and neither can any browser API.
 *
 * Proving a frame came from real hardware needs attestation the web platform
 * does not offer — Play Integrity or App Attest, i.e. a native app. So treat
 * camera-only as a speed bump, and let the UNPREDICTABLE CHALLENGE do the actual
 * work: an attacker must render a code they have not seen before, in convincing
 * handwriting, at the right angle, inside 90 seconds.
 *
 * `injection.ts` heuristics run here and are sent as an ADVISORY risk band. Every
 * one of them is defeatable and they must never auto-reject — a false positive
 * costs a real person their verification.
 */

const MEDIA_TYPE = "image/jpeg";
const JPEG_QUALITY = 0.92;

type Phase = "idle" | "starting" | "live" | "submitting" | "done" | "error";

interface Challenge {
  sessionId: string;
  instruction: string;
  expiresAt: number;
  ttlSeconds: number;
}

interface Outcome {
  passed: boolean;
  confidence: number;
  reason: string;
}

export default function CameraCapture({
  onComplete,
}: {
  /** Fires with the sessionId once a capture PASSES, for /api/attest to consume. */
  onComplete?: (sessionId: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [risk, setRisk] = useState<RiskBand | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  /** True once the video reports real dimensions — i.e. a frame exists to draw. */
  const [streaming, setStreaming] = useState(false);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Release the camera on unmount. Leaving it running leaves the indicator light
  // on, which people notice and do not like.
  useEffect(() => stopStream, [stopStream]);

  // Attach the stream AFTER the <video> element mounts.
  //
  // This element only renders once phase is "live", so assigning srcObject
  // inside start() ran while videoRef.current was still null — the guard there
  // silently skipped, the preview stayed black, and videoWidth stayed 0. The
  // capture then drew a 0x0 canvas and the model rejected the empty image with
  // "Failed to load image or audio file", which reads like a format problem and
  // is actually an ordering problem.
  useEffect(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (phase !== "live" || !video || !stream) return;
    if (video.srcObject === stream) return;
    video.srcObject = stream;
    void video.play().catch(() => {
      setPhase("error");
      setError("Could not start the preview. Check that no other app is using the camera.");
    });

    // Heuristics run here, not in start(), for the same reason: measuring frame
    // jitter needs a mounted element with a live stream. Backgrounded so they
    // never delay the capture, and advisory only — they must never block it.
    void (async () => {
      try {
        const check = await inspectStream(stream);
        const jitter = await measureFrameJitter(video, 3000);
        setRisk(toRiskBand(check, jitter.suspicious));
      } catch {
        /* advisory only */
      }
    })();
  }, [phase]);

  // Countdown. Purely informational — the server re-checks expiry on submit, so
  // a modified client that freezes this timer gains nothing.
  useEffect(() => {
    if (phase !== "live" || !challenge) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((challenge.expiresAt - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) {
        setPhase("error");
        setError("Time expired. Start a new capture.");
        stopStream();
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [phase, challenge, stopStream]);

  async function start() {
    setError("");
    setOutcome(null);
    setRisk(null);
    setStreaming(false);
    setPhase("starting");

    try {
      // Request the challenge FIRST. The clock starts server-side at issuance,
      // so acquiring the camera before this would eat the window.
      const res = await fetch("/api/liveness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not start a capture.");
      if (!data.expiresAt) {
        throw new Error(
          "This provider issues no challenge — set LIVENESS_PROVIDER=vision. " +
            "The mock provider passes everything and detects nothing.",
        );
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      // Do NOT touch videoRef here: the <video> renders only once phase is
      // "live", so it does not exist yet. The effect above attaches the stream
      // after it mounts.
      streamRef.current = stream;

      setChallenge({
        sessionId: data.sessionId,
        instruction: data.instruction,
        expiresAt: data.expiresAt,
        ttlSeconds: data.ttlSeconds,
      });
      setPhase("live");
    } catch (e) {
      stopStream();
      setPhase("error");
      setError(
        e instanceof Error
          ? e.name === "NotAllowedError"
            ? "Camera permission denied. This check cannot use an uploaded file."
            : e.message
          : "Could not start the camera.",
      );
    }
  }

  async function capture() {
    const video = videoRef.current;
    if (!video || !challenge) return;

    setPhase("submitting");
    try {
      // Draw the live frame to a canvas. This is the only path from camera to
      // bytes — there is no file picker to substitute into it.
      // A frame with no pixels encodes to a stub image, and the model rejects it
      // with an opaque "failed to load image" that looks like a format bug. Fail
      // here instead, where the actual cause is knowable.
      if (!video.videoWidth || !video.videoHeight) {
        setPhase("live");
        setError("No camera frame yet — wait for the preview to appear, then try again.");
        return;
      }

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable.");
      ctx.drawImage(video, 0, 0);

      const dataUrl = canvas.toDataURL(MEDIA_TYPE, JPEG_QUALITY);
      const imageBase64 = dataUrl.split(",")[1];

      const res = await fetch("/api/liveness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          sessionId: challenge.sessionId,
          imageBase64,
          mediaType: MEDIA_TYPE,
          risk,
        }),
      });
      const data = await res.json();

      if (res.status === 503) {
        // The check did not run. Not the user's fault, and their challenge is
        // still alive — let them retry rather than burning the attempt.
        setPhase("live");
        setError(`Verification unavailable: ${data.detail ?? "try again"}`);
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "Verification failed.");

      stopStream();
      setOutcome(data);
      setPhase("done");
      if (data.passed) onComplete?.(challenge.sessionId);
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "Capture failed.");
      stopStream();
    }
  }

  const urgent = secondsLeft <= 20;

  return (
    <div className="capture">
      {phase === "idle" && (
        <>
          <p>
            You will be given a one-time instruction and <strong>90 seconds</strong> to
            photograph yourself following it. The photo must come from your camera —
            there is no upload option.
          </p>
          <button onClick={start}>Start camera</button>
        </>
      )}

      {phase === "starting" && <p>Requesting camera…</p>}

      {(phase === "live" || phase === "submitting") && challenge && (
        <>
          <p className="instruction">{challenge.instruction}</p>
          <p className={`timer ${urgent ? "urgent" : ""}`}>{secondsLeft}s remaining</p>
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="preview"
            onLoadedMetadata={() => setStreaming(true)}
          />
          <button onClick={capture} disabled={phase === "submitting" || !streaming}>
            {phase === "submitting" ? "Checking…" : streaming ? "Take photo" : "Waiting for camera…"}
          </button>
          {risk === "review" && (
            <p className="hint">This capture will be flagged for manual review.</p>
          )}
        </>
      )}

      {phase === "done" && outcome && (
        <div className={outcome.passed ? "ok" : "bad"}>
          <p className="verdict">{outcome.passed ? "CAPTURE VERIFIED" : "DID NOT PASS"}</p>
          {!outcome.passed && outcome.reason && <p>{outcome.reason}</p>}
          {!outcome.passed && <button onClick={start}>Try again</button>}
        </div>
      )}

      {phase === "error" && (
        <>
          <p className="bad">{error}</p>
          <button onClick={start}>Try again</button>
        </>
      )}

      {phase === "live" && error && <p className="bad">{error}</p>}

      <style jsx>{`
        .capture { max-width: 520px; }
        .instruction { font-size: 1.15rem; font-weight: 600; margin: 8px 0; }
        .timer { font-variant-numeric: tabular-nums; color: var(--muted); margin: 4px 0 12px; }
        .timer.urgent { color: #d29922; font-weight: 700; }
        .preview { width: 100%; border-radius: 8px; background: #000; transform: scaleX(-1); }
        button { margin-top: 12px; padding: 10px 18px; font: inherit; border: 0;
                 border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
        button:disabled { opacity: 0.5; cursor: default; }
        .verdict { font-size: 1.3rem; font-weight: 700; letter-spacing: 0.05em; }
        .ok { color: #2ea043; } .bad { color: #f85149; }
        .hint { color: var(--muted); font-size: 0.9rem; }
      `}</style>
    </div>
  );
}
