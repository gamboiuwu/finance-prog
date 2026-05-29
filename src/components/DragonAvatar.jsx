import { useEffect } from 'react';

const MOOD_FRAME = {
  idle:     0,
  thinking: 5,
  talking:  2,
  happy:    7,
  error:    10,
  wave:     14,
  sleep:    17,
};

const FRAMES = Object.fromEntries(
  Array.from({ length: 21 }, (_, i) => [
    i,
    new URL(`../assets/dragon/${i}.webp`, import.meta.url).href,
  ])
);

// Per-mood CSS animation definitions
const MOOD_ANIM = {
  idle:     'dragon-float 3.5s ease-in-out infinite',
  thinking: 'dragon-think 2s ease-in-out infinite',
  talking:  'dragon-talk 0.75s ease-in-out infinite',
  happy:    'dragon-happy 0.65s ease-in-out infinite',
  error:    'dragon-error 0.45s ease-in-out 3',
  wave:     'dragon-wave 0.9s ease-in-out infinite',
  sleep:    'dragon-sleep 4.5s ease-in-out infinite',
};

const KEYFRAMES = `
@keyframes dragon-float {
  0%,100% { transform: translateY(0); }
  50%      { transform: translateY(-10px); }
}
@keyframes dragon-think {
  0%,100% { transform: translateY(0) rotate(0deg); }
  25%      { transform: translateY(-6px) rotate(-5deg); }
  75%      { transform: translateY(-3px) rotate(5deg); }
}
@keyframes dragon-talk {
  0%,100% { transform: translateY(0) scale(1); }
  25%      { transform: translateY(-6px) scale(1.04); }
  75%      { transform: translateY(-2px) scale(1.01); }
}
@keyframes dragon-happy {
  0%,100% { transform: translateY(0) scale(1) rotate(0deg); }
  30%      { transform: translateY(-18px) scale(1.07) rotate(-4deg); }
  60%      { transform: translateY(-8px) scale(1.03) rotate(4deg); }
}
@keyframes dragon-error {
  0%,100% { transform: translateX(0); }
  20%      { transform: translateX(-8px) rotate(-3deg); }
  40%      { transform: translateX(8px) rotate(3deg); }
  60%      { transform: translateX(-5px) rotate(-2deg); }
  80%      { transform: translateX(5px) rotate(2deg); }
}
@keyframes dragon-wave {
  0%,100% { transform: rotate(0deg); transform-origin: 50% 100%; }
  30%      { transform: rotate(-10deg); transform-origin: 50% 100%; }
  70%      { transform: rotate(10deg); transform-origin: 50% 100%; }
}
@keyframes dragon-sleep {
  0%,100% { transform: translateY(0) scale(1); opacity: 0.80; }
  50%      { transform: translateY(4px) scale(0.97); opacity: 1; }
}
`;

let styleInjected = false;
function injectKeyframes() {
  if (styleInjected || typeof document === 'undefined') return;
  const el = document.createElement('style');
  el.textContent = KEYFRAMES;
  document.head.appendChild(el);
  styleInjected = true;
}

export default function DragonAvatar({ mood = 'idle', size = 64, className = '' }) {
  useEffect(() => { injectKeyframes(); }, []);

  const frame = MOOD_FRAME[mood] ?? 0;
  const src = FRAMES[frame];

  return (
    <img
      src={src}
      alt={`Ledger dragon — ${mood}`}
      width={size}
      height={size}
      draggable={false}
      className={['object-contain select-none', className].filter(Boolean).join(' ')}
      style={{ animation: MOOD_ANIM[mood] ?? MOOD_ANIM.idle }}
    />
  );
}
