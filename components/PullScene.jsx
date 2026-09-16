'use client';

/**
 * components/PullScene.jsx — the progress animation.
 *
 * Kept as one SVG because it already was declarative: motion is CSS keyframes
 * gated by a single `running` class, and progress is one strokeDashoffset.
 *
 * Three couplings are load-bearing and live here as named constants rather
 * than scattered through the markup, which is how they got out of step before:
 *
 *   - WIRE must equal both the SVG stroke-dasharray and the drawn line length
 *     (WIRE_X2 − WIRE_X1). Change one and the bar stops reaching the end.
 *   - The counter text sits at the centre of the laptop screen, which is a
 *     fraction of the *trimmed* artwork. Re-crop laptop-cut.png and it moves.
 *   - Gradient stops are hex literals, not var(): a CSS custom property does
 *     not resolve inside <stop stop-color>.
 */

const WIRE_X1 = 192;
const WIRE_X2 = 678;
const WIRE = WIRE_X2 - WIRE_X1;   // 486

// Centre of the cyan screen as a fraction of laptop-cut.png, measured once.
const LAPTOP = { x: 686, y: 28, w: 168, h: 114, cx: 0.527, cy: 0.332 };
const SCREEN_X = LAPTOP.x + LAPTOP.w * LAPTOP.cx;
const SCREEN_Y = LAPTOP.y + LAPTOP.h * LAPTOP.cy;

export default function PullScene({ running, done = 0, total = 0, caption = 'WAITING' }) {
  const frac = total > 0 ? Math.min(done / total, 1) : 0;

  return (
    <div className={`pull-scene ${running ? 'running' : ''}`}>
      <svg viewBox="0 0 900 190" className="w-full max-w-[720px]" role="img"
           aria-label={`${done} of ${total} transcripts fetched`}>
        <defs>
          {/* Hex, not var() — custom properties do not resolve in <stop>. */}
          <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#7c6cf5" stopOpacity="0.25" />
            <stop offset="50%" stopColor="#4dd6c1" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#7c6cf5" stopOpacity="0.25" />
          </linearGradient>
          <linearGradient id="fill" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#7c6cf5" />
            <stop offset="100%" stopColor="#4dd6c1" />
          </linearGradient>
          <clipPath id="tile">
            <rect x="118" y="53" width="64" height="64" rx="15" />
          </clipPath>
        </defs>

        <circle className="pulse" cx="150" cy="85" r="46" fill="#7c6cf5" opacity="0.10" />
        <image href="/assets/gong.png" x="118" y="53" width="64" height="64" clipPath="url(#tile)" />
        <rect x="118" y="53" width="64" height="64" rx="15" fill="none"
              stroke="#252a38" strokeWidth="1" />

        <line x1={WIRE_X1} y1="85" x2={WIRE_X2} y2="85"
              stroke="url(#beam)" strokeWidth="3" strokeLinecap="round" />
        <line className="flow" x1={WIRE_X1} y1="85" x2={WIRE_X2} y2="85"
              stroke="#4dd6c1" strokeWidth="1" strokeDasharray="3 9"
              strokeLinecap="round" opacity="0.5" />
        <line x1={WIRE_X1} y1="85" x2={WIRE_X2} y2="85"
              stroke="url(#fill)" strokeWidth="3" strokeLinecap="round"
              strokeDasharray={WIRE}
              strokeDashoffset={WIRE * (1 - frac)}
              style={{ transition: 'stroke-dashoffset 1.1s cubic-bezier(.25,.9,.25,1)' }} />

        <g className="pkts">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <rect key={i} className="pkt" x={WIRE_X1} y="81" width="9" height="8" rx="2"
                  fill="#4dd6c1" opacity="0" style={{ animationDelay: `${i * 0.93}s` }} />
          ))}
        </g>

        <image href="/assets/laptop-cut.png"
               x={LAPTOP.x} y={LAPTOP.y} width={LAPTOP.w} height={LAPTOP.h} />
        <text x={SCREEN_X} y={SCREEN_Y} textAnchor="middle"
              fill="#0b0d12" fontSize="15" fontWeight="700"
              fontFamily="ui-monospace, monospace">
          {total ? `${done}/${total}` : '—'}
        </text>
        <text x={SCREEN_X} y={SCREEN_Y + 14} textAnchor="middle"
              fill="#0b0d12" fontSize="8" opacity="0.65"
              fontFamily="ui-monospace, monospace" letterSpacing="1">
          {caption}
        </text>
      </svg>

    </div>
  );
}
