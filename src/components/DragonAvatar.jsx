// Maps mood names to dragon sprite frame numbers
const MOOD_FRAME = {
  idle:     0,
  thinking: 5,
  talking:  2,
  happy:    7,
  error:    10,
  wave:     14,
  sleep:    17,
};

// Eagerly import all frames so Vite bundles them
const FRAMES = Object.fromEntries(
  Array.from({ length: 21 }, (_, i) => [
    i,
    new URL(`../assets/dragon/${i}.webp`, import.meta.url).href,
  ])
);

export default function DragonAvatar({ mood = 'idle', size = 64, className = '' }) {
  const frame = MOOD_FRAME[mood] ?? 0;
  const src = FRAMES[frame];

  const pulse = mood === 'thinking';
  const bounce = mood === 'happy';

  return (
    <img
      src={src}
      alt={`Ledger dragon — ${mood}`}
      width={size}
      height={size}
      className={[
        'object-contain select-none',
        pulse  ? 'animate-pulse'  : '',
        bounce ? 'animate-bounce' : '',
        className,
      ].filter(Boolean).join(' ')}
      style={{ imageRendering: 'pixelated' }}
    />
  );
}
