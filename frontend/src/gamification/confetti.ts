/**
 * Small canvas confetti burst for the Results screen. Raw canvas 2D, same
 * approach as pitch/graph.ts — no dependency, and it removes its own canvas
 * when the animation finishes so nothing leaks if the screen unmounts.
 */

const PARTICLE_COUNT = 90;
const DURATION_MS = 1500;
const GRAVITY = 0.00045; // px per ms^2
const DRAG = 0.999;

interface Particle {
  x: number; y: number; vx: number; vy: number;
  size: number; rotation: number; spin: number; color: string;
}

const COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#34d399', '#8b5cf6', '#ff5ca0'];

export function burstConfetti(container: HTMLElement): () => void {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';

  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  container.appendChild(canvas);

  const dpr = window.devicePixelRatio || 1;
  const width = container.clientWidth;
  const height = container.clientHeight;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const originX = width / 2;
  const originY = height * 0.35;
  const particles: Particle[] = Array.from({ length: PARTICLE_COUNT }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.15 + Math.random() * 0.35;
    return {
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 0.15, // bias upward so it arcs
      size: 5 + Math.random() * 6,
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.02,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    };
  });

  let rafId: number | null = null;
  let startTs: number | null = null;
  let cancelled = false;

  const cleanup = (): void => {
    cancelled = true;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    canvas.remove();
  };

  const frame = (ts: number): void => {
    if (cancelled) return;
    if (startTs === null) startTs = ts;
    const elapsed = ts - startTs;
    if (elapsed >= DURATION_MS) return cleanup();

    const dt = 16; // fixed step keeps motion stable if a frame is dropped
    ctx.clearRect(0, 0, width, height);
    const fade = 1 - elapsed / DURATION_MS;

    for (const p of particles) {
      p.vy += GRAVITY * dt;
      p.vx *= DRAG;
      p.vy *= DRAG;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.spin * dt;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.globalAlpha = Math.max(0, fade);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }

    rafId = requestAnimationFrame(frame);
  };

  rafId = requestAnimationFrame(frame);
  return cleanup;
}
