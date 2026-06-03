import { useEffect } from 'react';

// Map each mood to the sprite frame index that best matches that expression.
// Frame 0  = neutral/idle face
// Frame 2  = mouth open (speaking)
// Frame 5  = focused/furrowed (thinking)
// Frame 7  = wide smile (happy/wave greeting)
// Frame 10 = worried/alarmed (error)
// Frame 14 = cheerful wave face
// Frame 17 = eyes closed / drowsy (sleep/setup)
const MOOD_FRAME = {
  idle:     0,   // neutral — no expression needed for "resting"
  thinking: 5,   // focused, furrowed brow
  talking:  2,   // mouth open
  happy:    7,   // wide smile (after a good answer)
  error:    10,  // worried/alarmed
  wave:     14,  // cheerful greeting face
  sleep:    17,  // eyes closed (key-setup dormant state)
};

const FRAMES = Object.fromEntries(
  Array.from({ length: 21 }, (_, i) => [
    i,
    new URL(`../assets/dragon/${i}.webp`, import.meta.url).href,
  ])
);

// Issue 1: Only animate during ACTIVE states. Idle and sleep are intentionally
// still (no bouncing dragon when the user isn't doing anything). Each active
// mood has an animation matched to its emotional character.
const MOOD_ANIM = {
  idle:     'none',                                        // still — nothing is happening
  thinking: 'dragon-think 2s ease-in-out infinite',       // gentle sway while pondering
  talking:  'dragon-talk 0.75s ease-in-out infinite',     // bob while speaking
  happy:    'dragon-happy 0.65s ease-in-out infinite',    // bouncy celebration
  error:    'dragon-error 0.45s ease-in-out 3',           // brief shake then stops
  wave:     'dragon-wave 0.9s ease-in-out infinite',      // friendly greeting sway
  sleep:    'none',                                        // still — dormant on key-setup
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
  // Issue 1: fall back to 'none' (not the idle animation) so unknown moods stay still.
  const anim = MOOD_ANIM[mood] ?? 'none';

  return (
    <img
      src={src}
      alt={`Ledger dragon — ${mood}`}
      width={size}
      height={size}
      draggable={false}
      className={['object-contain select-none', className].filter(Boolean).join(' ')}
      style={{ animation: anim }}
    />
  );
}
