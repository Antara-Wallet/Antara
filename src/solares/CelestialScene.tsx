import { useEffect, useRef } from 'react';
import './celestial-scene.css';

interface CelestialSceneProps {
  active?: boolean;
  className?: string;
}

interface Star {
  x: number;
  y: number;
  radius: number;
  light: number;
  phase: number;
  speed: number;
}

// A fixed constellation keeps the scene stable through navigation and hydration.
function createStars(): Star[] {
  let seed = 23117;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  return Array.from({ length: 100 }, (_, index) => ({
    x: random(),
    y: random(),
    radius: index % 19 === 0 ? 1.25 : 0.3 + random() * 0.55,
    light: 0.18 + random() * 0.45,
    phase: random() * Math.PI * 2,
    speed: 0.18 + random() * 0.3,
  }));
}

/** Decorative atmosphere. It never intercepts input or participates in wallet state. */
export function CelestialScene({ active = true, className = '' }: CelestialSceneProps) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const scene = sceneRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d', { alpha: true });
    if (!scene || !canvas || !context) return;

    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const stars = createStars();
    let width = 1;
    let height = 1;
    let frame = 0;
    let running = false;
    let lastPaint = 0;
    let elapsed = 0;
    let pointerX = 0;
    let pointerY = 0;
    let positionX = 0;
    let positionY = 0;

    const draw = () => {
      context.clearRect(0, 0, width, height);
      for (const star of stars) {
        const pulse = 0.76 + Math.sin(elapsed * star.speed + star.phase) * 0.24;
        const x = star.x * width + positionX * star.radius * 3;
        const y = star.y * height + positionY * star.radius * 3;
        const light = star.light * pulse;
        context.fillStyle = `rgba(196, 219, 255, ${light})`;
        context.beginPath();
        context.arc(x, y, star.radius, 0, Math.PI * 2);
        context.fill();
        if (star.radius > 1) {
          context.strokeStyle = `rgba(162, 198, 255, ${light * 0.25})`;
          context.lineWidth = 0.65;
          context.beginPath();
          context.moveTo(x - 4.5, y);
          context.lineTo(x + 4.5, y);
          context.moveTo(x, y - 4.5);
          context.lineTo(x, y + 4.5);
          context.stroke();
        }
      }
    };

    const animate = (now: number) => {
      if (!running) return;
      // The native WebView needs atmosphere, not a 120 fps render loop.
      if (!lastPaint || now - lastPaint >= 1000 / 30) {
        const delta = lastPaint ? Math.min((now - lastPaint) / 1000, 0.1) : 0;
        elapsed += delta;
        lastPaint = now;
        positionX += (pointerX - positionX) * 0.065;
        positionY += (pointerY - positionY) * 0.065;
        scene.style.setProperty('--celestial-x', `${(positionX * 7).toFixed(2)}px`);
        scene.style.setProperty('--celestial-y', `${(positionY * 5).toFixed(2)}px`);
        draw();
      }
      frame = window.requestAnimationFrame(animate);
    };

    const resize = () => {
      width = Math.max(1, scene.clientWidth);
      height = Math.max(1, scene.clientHeight);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      draw();
    };

    const updateMotion = () => {
      const shouldRun = active && !motionPreference.matches && !document.hidden;
      scene.dataset.motion = shouldRun ? 'running' : 'still';
      window.cancelAnimationFrame(frame);
      running = shouldRun;
      lastPaint = 0;
      if (running) {
        frame = window.requestAnimationFrame(animate);
      } else {
        pointerX = pointerY = positionX = positionY = 0;
        scene.style.setProperty('--celestial-x', '0px');
        scene.style.setProperty('--celestial-y', '0px');
        draw();
      }
    };

    const move = (event: PointerEvent) => {
      if (!running || event.pointerType === 'touch') return;
      pointerX = Math.max(-1, Math.min(1, (event.clientX / window.innerWidth - 0.5) * 2));
      pointerY = Math.max(-1, Math.min(1, (event.clientY / window.innerHeight - 0.5) * 2));
    };
    const resetPointer = () => { pointerX = 0; pointerY = 0; };
    const observer = new ResizeObserver(resize);
    observer.observe(scene);
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('blur', resetPointer);
    document.documentElement.addEventListener('pointerleave', resetPointer);
    document.addEventListener('visibilitychange', updateMotion);
    motionPreference.addEventListener('change', updateMotion);
    resize();
    updateMotion();

    return () => {
      running = false;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('blur', resetPointer);
      document.documentElement.removeEventListener('pointerleave', resetPointer);
      document.removeEventListener('visibilitychange', updateMotion);
      motionPreference.removeEventListener('change', updateMotion);
    };
  }, [active]);

  return (
    <div ref={sceneRef} className={`antara-celestial-scene ${className}`.trim()} data-motion="still" aria-hidden="true">
      <div className="antara-celestial-nebula antara-celestial-nebula-primary" />
      <div className="antara-celestial-nebula antara-celestial-nebula-secondary" />
      <canvas ref={canvasRef} className="antara-celestial-stars" />
      <div className="antara-celestial-vignette" />
    </div>
  );
}
