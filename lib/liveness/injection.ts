/**
 * injection.ts — virtual camera / stream injection heuristics.
 *
 * WHY THIS IS THE RIGHT THING TO BUILD
 * Unit 42 found that building a real-time face swap takes about an hour with
 * consumer hardware, and that the slowest part of the whole attack was wiring up
 * a virtual camera feed. That tells you where the chokepoint is: the attack is a
 * fake CAMERA, not a clever face. So the defence is proving the stream came from
 * real hardware, not running pixel forensics on whether a face "looks" synthetic.
 *
 * HONEST LIMITS — say these out loud in any demo:
 *   - Every check here is a heuristic and every one is defeatable. A virtual cam
 *     that spoofs its device label and capabilities beats all of them.
 *   - Browsers deliberately limit hardware introspection, so this is a ceiling,
 *     not a floor. The durable fix is a native app with camera attestation, or a
 *     vendor that does injection detection in the stream itself.
 *   - Treat the output as a RISK SIGNAL feeding a human review queue. Never
 *     auto-reject a candidate on it. A false positive here costs someone a job.
 */

export type InjectionSignal =
  | "virtual_device_label"
  | "no_hardware_capabilities"
  | "implausible_frame_timing"
  | "resolution_too_perfect"
  | "no_device_id"
  | "label_unavailable";

export interface InjectionCheck {
  /** 0 = no concern, 100 = every heuristic tripped. */
  score: number;
  signals: InjectionSignal[];
  /** Safe to show an operator. Never shown to the candidate. */
  notes: string[];
}

/**
 * Known virtual camera software, lowercased substrings.
 * Maintain this list — it goes stale fast. Absence of a match proves nothing.
 */
const VIRTUAL_CAM_MARKERS = [
  "obs",
  "manycam",
  "xsplit",
  "snap camera",
  "vcam",
  "e2esoft",
  "droidcam",
  "epoccam",
  "mmhmm",
  "camo",
  "splitcam",
  "yamicam",
  "virtual",
  "fake",
  "avermedia live",
  "ndi",
  "unity video",
  "restream",
];

const WEIGHTS: Record<InjectionSignal, number> = {
  virtual_device_label: 45,
  no_hardware_capabilities: 25,
  implausible_frame_timing: 20,
  resolution_too_perfect: 5,
  no_device_id: 3,
  label_unavailable: 2,
};

/**
 * Inspect the live track and the device list for signs the feed is synthetic.
 * Call AFTER getUserMedia has resolved — device labels are empty strings until
 * the user has granted camera permission.
 */
export async function inspectStream(stream: MediaStream): Promise<InjectionCheck> {
  const signals: InjectionSignal[] = [];
  const notes: string[] = [];

  const track = stream.getVideoTracks()[0];
  if (!track) {
    return { score: 0, signals: [], notes: ["No video track to inspect."] };
  }

  const settings = track.getSettings?.() ?? {};

  // 1. Device label. The cheapest and most effective check, and the first thing
  //    a competent attacker defeats — but most don't bother.
  const label = (track.label || "").toLowerCase();
  if (!label) {
    signals.push("label_unavailable");
    notes.push("Camera label unavailable (permission not yet granted, or a privacy-hardened browser).");
  } else if (VIRTUAL_CAM_MARKERS.some((m) => label.includes(m))) {
    signals.push("virtual_device_label");
    notes.push(`Camera reports itself as virtual software: "${track.label}".`);
  }

  // Also scan the full device list — an attacker may select a real camera while
  // a virtual one sits installed alongside it. That is weaker evidence, so it is
  // recorded as a note only and does not score.
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const virtualOthers = devices
      .filter((d) => d.kind === "videoinput")
      .filter((d) => VIRTUAL_CAM_MARKERS.some((m) => d.label.toLowerCase().includes(m)));
    if (virtualOthers.length > 0) {
      notes.push(
        `Virtual camera software is installed on this machine (${virtualOthers.length} device(s)), though not the one selected.`,
      );
    }
  } catch {
    notes.push("Could not enumerate devices.");
  }

  // 2. Hardware capabilities. Real sensors expose controls a synthetic pipe has
  //    no reason to implement: focus, exposure, white balance, zoom, torch.
  try {
    const caps: MediaTrackCapabilities = track.getCapabilities?.() ?? {};
    const hardwareHints = [
      "focusMode",
      "exposureMode",
      "whiteBalanceMode",
      "zoom",
      "torch",
      "facingMode",
    ].filter((k) => k in caps);

    if (hardwareHints.length === 0) {
      signals.push("no_hardware_capabilities");
      notes.push("Track exposes no camera hardware controls at all — typical of a synthetic source.");
    } else {
      notes.push(`Hardware controls present: ${hardwareHints.join(", ")}.`);
    }
  } catch {
    notes.push("getCapabilities() unsupported in this browser — capability check skipped.");
  }

  if (!settings.deviceId) {
    signals.push("no_device_id");
    notes.push("Track reports no deviceId.");
  }

  // 3. Resolution shape. Virtual cams very often emit exactly 1920x1080 or
  //    1280x720 at exactly 30fps. Real webcams frequently do too, so this is a
  //    deliberately tiny weight — it is corroboration, never evidence.
  const { width, height, frameRate } = settings;
  if (width && height && frameRate) {
    const perfect =
      ((width === 1920 && height === 1080) || (width === 1280 && height === 720)) &&
      Number.isInteger(frameRate) &&
      frameRate === 30;
    if (perfect) {
      signals.push("resolution_too_perfect");
      notes.push(`Exactly ${width}x${height} @ ${frameRate}fps.`);
    }
  }

  const score = Math.min(100, signals.reduce((sum, s) => sum + WEIGHTS[s], 0));
  return { score, signals, notes };
}

/**
 * Frame-timing analysis. Real sensors jitter — exposure adjusts, USB bandwidth
 * fluctuates, the OS scheduler interferes. A rendered or file-backed feed is
 * often metronomic. Run this over ~3 seconds during the liveness challenge.
 *
 * Returns a coefficient of variation for inter-frame intervals. Below ~0.02 is
 * suspiciously regular for a physical camera. Tune against your own device
 * population before you trust the threshold — laptop webcams vary enormously.
 */
export function measureFrameJitter(
  video: HTMLVideoElement,
  sampleMs = 3000,
): Promise<{ cv: number; samples: number; suspicious: boolean }> {
  return new Promise((resolve) => {
    const intervals: number[] = [];
    let last = performance.now();
    let handle = 0;
    const started = last;

    // requestVideoFrameCallback fires per decoded frame; fall back to rAF where
    // it is unavailable (Firefox at time of writing).
    const anyVideo = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: FrameRequestCallback) => number;
      cancelVideoFrameCallback?: (h: number) => void;
    };
    const useRvfc = typeof anyVideo.requestVideoFrameCallback === "function";

    const step = (now: number) => {
      intervals.push(now - last);
      last = now;
      if (now - started >= sampleMs) return finish();
      handle = useRvfc
        ? anyVideo.requestVideoFrameCallback!(step)
        : requestAnimationFrame(step);
    };

    const finish = () => {
      if (useRvfc) anyVideo.cancelVideoFrameCallback?.(handle);
      else cancelAnimationFrame(handle);

      // Drop the first few samples: startup is noisy while the sensor settles.
      const s = intervals.slice(3).filter((x) => x > 0 && x < 500);
      if (s.length < 20) return resolve({ cv: 1, samples: s.length, suspicious: false });

      const mean = s.reduce((a, b) => a + b, 0) / s.length;
      const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length;
      const cv = Math.sqrt(variance) / mean;
      resolve({ cv, samples: s.length, suspicious: cv < 0.02 });
    };

    handle = useRvfc
      ? anyVideo.requestVideoFrameCallback!(step)
      : requestAnimationFrame(step);
  });
}

/**
 * Combine both checks into one risk band. Bands, not numbers — never return a
 * raw score to the client, or an attacker iterates against your endpoint until
 * it passes.
 */
export type RiskBand = "clear" | "review" | "blocked";

export function toRiskBand(check: InjectionCheck, jitterSuspicious: boolean): RiskBand {
  const score = check.score + (jitterSuspicious ? 20 : 0);
  if (score >= 45) return "blocked";
  if (score >= 20) return "review";
  return "clear";
}
