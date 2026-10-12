"use client";

/**
 * A smoke trail behind the cursor: a small fluid simulation on the GPU.
 *
 * The cursor stirs a velocity field and drops a little dye into it; each frame
 * the dye is carried along by the flow, swirls (vorticity), and fades. It is
 * the classic "stable fluids" method: advect, add curl, project the velocity
 * so it stays divergence-free (a few Jacobi pressure iterations), then draw the
 * dye with its brightness as alpha, so it lies over the page like smoke.
 *
 * Kept light on purpose: only with a mouse or trackpad (a phone keeps the
 * drifting clouds), never with "reduce motion", only where WebGL2 can render
 * to half-float textures, and the loop stops whenever the cursor has rested
 * long enough for the smoke to fade, or the tab is hidden. No library.
 */

import { useEffect, useRef } from "react";

const SIM_RES = 128; // velocity and pressure grid, short side
const DYE_RES = 512; // dye texture, short side
const PRESSURE_ITERATIONS = 18;
const CURL = 22;
const VELOCITY_DISSIPATION = 0.9;
const DYE_DISSIPATION = 1.4;
const SPLAT_RADIUS = 0.0022;
const SPLAT_FORCE = 5200;
const DYE_STRENGTH = 0.11;
// How strongly the smoke shows: a soft haze, so white text over it stays easy to read.
const SHOW = 0.45;
const MAX_ALPHA = 0.32;
const IDLE_MS = 4500;

// Solana's purple, blue and green, cycled along the trail.
const COLORS: [number, number, number][] = [
  [0.6, 0.27, 1.0],
  [0.0, 0.76, 1.0],
  [0.08, 0.95, 0.58],
];

const VERT = `#version 300 es
in vec2 aPosition;
out vec2 vUv, vL, vR, vT, vB;
uniform vec2 texelSize;
void main () {
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAG = {
  splat: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTarget;
uniform float aspectRatio, radius;
uniform vec3 color;
uniform vec2 point;
void main () {
  vec2 p = vUv - point;
  p.x *= aspectRatio;
  o = vec4(texture(uTarget, vUv).xyz + exp(-dot(p, p) / radius) * color, 1.0);
}`,
  advection: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uVelocity, uSource;
uniform vec2 texelSize;
uniform float dt, dissipation;
void main () {
  vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
  o = texture(uSource, coord) / (1.0 + dissipation * dt);
}`,
  divergence: `#version 300 es
precision mediump float;
in vec2 vUv, vL, vR, vT, vB;
out vec4 o;
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).x, R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y, B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vL.x < 0.0) L = -C.x;
  if (vR.x > 1.0) R = -C.x;
  if (vT.y > 1.0) T = -C.y;
  if (vB.y < 0.0) B = -C.y;
  o = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`,
  curl: `#version 300 es
precision mediump float;
in vec2 vUv, vL, vR, vT, vB;
out vec4 o;
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).y, R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x, B = texture(uVelocity, vB).x;
  o = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`,
  vorticity: `#version 300 es
precision highp float;
in vec2 vUv, vL, vR, vT, vB;
out vec4 o;
uniform sampler2D uVelocity, uCurl;
uniform float curl, dt;
void main () {
  float L = texture(uCurl, vL).x, R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x, B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 v = texture(uVelocity, vUv).xy + force * dt;
  o = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
}`,
  pressure: `#version 300 es
precision mediump float;
in vec2 vUv, vL, vR, vT, vB;
out vec4 o;
uniform sampler2D uPressure, uDivergence;
void main () {
  float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
  o = vec4((L + R + B + T - texture(uDivergence, vUv).x) * 0.25, 0.0, 0.0, 1.0);
}`,
  gradient: `#version 300 es
precision mediump float;
in vec2 vUv, vL, vR, vT, vB;
out vec4 o;
uniform sampler2D uPressure, uVelocity;
void main () {
  float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
  o = vec4(texture(uVelocity, vUv).xy - vec2(R - L, T - B), 0.0, 1.0);
}`,
  scale: `#version 300 es
precision mediump float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTexture;
uniform float value;
void main () { o = value * texture(uTexture, vUv); }`,
  display: `#version 300 es
precision mediump float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTexture;
void main () {
  vec3 c = min(texture(uTexture, vUv).rgb, vec3(1.0)) * ${SHOW.toFixed(2)};
  float a = max(c.r, max(c.g, c.b));
  // Premultiplied: smoke over the page, never more than MAX_ALPHA covering it.
  float k = a > ${MAX_ALPHA.toFixed(2)} ? ${MAX_ALPHA.toFixed(2)} / a : 1.0;
  o = vec4(c, a) * k;
}`,
};

type Program = { program: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };
type Double = { read: Target; write: Target; swap(): void };

export default function FluidTrail() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (!matchMedia("(pointer: fine)").matches || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!gl || !gl.getExtension("EXT_color_buffer_float")) return; // no trail rather than a broken one

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    let programs: Record<keyof typeof FRAG, Program>;
    try {
      const vert = compile(gl.VERTEX_SHADER, VERT);
      programs = Object.fromEntries(
        Object.entries(FRAG).map(([name, src]) => {
          const program = gl.createProgram()!;
          gl.attachShader(program, vert);
          gl.attachShader(program, compile(gl.FRAGMENT_SHADER, src));
          gl.bindAttribLocation(program, 0, "aPosition");
          gl.linkProgram(program);
          if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link");
          const u: Program["u"] = {};
          for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
            const n = gl.getActiveUniform(program, i)!.name;
            u[n] = gl.getUniformLocation(program, n);
          }
          return [name, { program, u }];
        }),
      ) as Record<keyof typeof FRAG, Program>;
    } catch {
      return;
    }

    // One full-screen quad.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    const target = (w: number, h: number): Target => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fbo, w, h };
    };
    const double = (w: number, h: number): Double => {
      const d = { read: target(w, h), write: target(w, h), swap() { [d.read, d.write] = [d.write, d.read]; } };
      return d;
    };
    const size = (res: number) => {
      const aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
      const short = Math.round(res), long = Math.round(res * (aspect < 1 ? 1 / aspect : aspect));
      return aspect >= 1 ? { w: long, h: short } : { w: short, h: long };
    };

    let velocity: Double, dye: Double, pressure: Double, divergence: Target, curl: Target;
    const allocate = () => {
      canvas.width = Math.round(innerWidth * Math.min(devicePixelRatio, 1.5));
      canvas.height = Math.round(innerHeight * Math.min(devicePixelRatio, 1.5));
      const s = size(SIM_RES), d = size(DYE_RES);
      velocity = double(s.w, s.h);
      pressure = double(s.w, s.h);
      divergence = target(s.w, s.h);
      curl = target(s.w, s.h);
      dye = double(d.w, d.h);
    };
    allocate();

    const run = (p: Program, out: Target | null, set: (u: Program["u"]) => void, texel?: Target) => {
      gl.useProgram(p.program);
      const t = texel ?? out;
      if (p.u.texelSize && t) gl.uniform2f(p.u.texelSize, 1 / t.w, 1 / t.h);
      set(p.u);
      if (out) {
        gl.viewport(0, 0, out.w, out.h);
        gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
      } else {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    };
    let unit = 0;
    const bind = (loc: WebGLUniformLocation | null | undefined, t: Target) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniform1i(loc ?? null, unit++);
    };

    const splat = (x: number, y: number, dx: number, dy: number, color: [number, number, number]) => {
      const aspect = canvas.width / canvas.height;
      gl.disable(gl.BLEND);
      unit = 0;
      run(programs.splat, velocity.write, (u) => {
        bind(u.uTarget, velocity.read);
        gl.uniform1f(u.aspectRatio, aspect);
        gl.uniform2f(u.point, x, y);
        gl.uniform3f(u.color, dx, dy, 0);
        gl.uniform1f(u.radius, SPLAT_RADIUS * (aspect > 1 ? aspect : 1));
      });
      velocity.swap();
      unit = 0;
      run(programs.splat, dye.write, (u) => {
        bind(u.uTarget, dye.read);
        gl.uniform1f(u.aspectRatio, aspect);
        gl.uniform2f(u.point, x, y);
        gl.uniform3f(u.color, color[0] * DYE_STRENGTH, color[1] * DYE_STRENGTH, color[2] * DYE_STRENGTH);
        gl.uniform1f(u.radius, SPLAT_RADIUS * (aspect > 1 ? aspect : 1));
      });
      dye.swap();
    };

    const step = (dt: number) => {
      gl.disable(gl.BLEND);
      unit = 0;
      run(programs.curl, curl, (u) => bind(u.uVelocity, velocity.read));
      unit = 0;
      run(programs.vorticity, velocity.write, (u) => {
        bind(u.uVelocity, velocity.read);
        bind(u.uCurl, curl);
        gl.uniform1f(u.curl, CURL);
        gl.uniform1f(u.dt, dt);
      });
      velocity.swap();
      unit = 0;
      run(programs.divergence, divergence, (u) => bind(u.uVelocity, velocity.read));
      unit = 0;
      run(programs.scale, pressure.write, (u) => {
        bind(u.uTexture, pressure.read);
        gl.uniform1f(u.value, 0.8);
      });
      pressure.swap();
      for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
        unit = 0;
        run(programs.pressure, pressure.write, (u) => {
          bind(u.uPressure, pressure.read);
          bind(u.uDivergence, divergence);
        });
        pressure.swap();
      }
      unit = 0;
      run(programs.gradient, velocity.write, (u) => {
        bind(u.uPressure, pressure.read);
        bind(u.uVelocity, velocity.read);
      });
      velocity.swap();
      unit = 0;
      run(programs.advection, velocity.write, (u) => {
        bind(u.uVelocity, velocity.read);
        bind(u.uSource, velocity.read);
        gl.uniform1f(u.dt, dt);
        gl.uniform1f(u.dissipation, VELOCITY_DISSIPATION);
      });
      velocity.swap();
      unit = 0;
      run(
        programs.advection,
        dye.write,
        (u) => {
          bind(u.uVelocity, velocity.read);
          bind(u.uSource, dye.read);
          gl.uniform1f(u.dt, dt);
          gl.uniform1f(u.dissipation, DYE_DISSIPATION);
        },
        velocity.read,
      );
      dye.swap();
    };

    const draw = () => {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      unit = 0;
      run(programs.display, null, (u) => bind(u.uTexture, dye.read));
    };

    // The loop runs only while there's smoke to move: from a cursor move until it has faded.
    let frame = 0, last = 0, lastMove = 0, hue = 0;
    let prev: { x: number; y: number } | null = null;
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 60);
      last = now;
      step(dt);
      draw();
      frame = now - lastMove < IDLE_MS && !document.hidden ? requestAnimationFrame(loop) : 0;
    };
    const wake = () => {
      if (!frame && !document.hidden) {
        last = performance.now();
        frame = requestAnimationFrame(loop);
      }
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      const x = e.clientX / innerWidth, y = 1 - e.clientY / innerHeight;
      if (prev) {
        const dx = x - prev.x, dy = y - prev.y;
        if (dx * dx + dy * dy > 1e-8) {
          hue = (hue + Math.hypot(dx, dy) * 1.6) % COLORS.length;
          const i = Math.floor(hue), f = hue - i;
          const a = COLORS[i], b = COLORS[(i + 1) % COLORS.length];
          const color: [number, number, number] = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
          const aspect = canvas.width / canvas.height;
          splat(x, y, dx * SPLAT_FORCE * (aspect < 1 ? aspect : 1), dy * SPLAT_FORCE * (aspect > 1 ? 1 / aspect : 1), color);
          lastMove = performance.now();
          wake();
        }
      }
      prev = { x, y };
    };
    const onLeave = () => (prev = null);
    const onResize = () => {
      allocate();
      prev = null;
    };
    const onVisibility = () => {
      if (document.hidden && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };

    addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return <canvas ref={ref} className="fluid-trail" aria-hidden="true" />;
}
