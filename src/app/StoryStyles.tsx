import { useId } from "react";
import { useRadioKeys } from "./CaptionPickers";
import { storyStyleIds, storyStyles, type StoryStyle } from "../../shared/story";

// The picture styles of a narrated video, each with a small drawn sample of the same little scene (sun, hill, a
// character) in that style. The samples are drawings in the page, not AI pictures: they show the look, not a result.

const ink = { stroke: "#15171d", strokeWidth: 2.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** The sample scene of one style (viewBox 100 × 120). */
function Sample({ style }: { style: StoryStyle }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const ref = (name: string) => `url(#${id}${name})`;
  switch (style) {
    case "doodle":
      return (
        <svg viewBox="0 0 100 120" aria-hidden="true">
          <rect width="100" height="120" fill="#fbf6ec" />
          <circle cx="76" cy="24" r="11" fill="#ffe28a" {...ink} />
          <path d="M70 9 l-2 -5 M86 12 l4 -4 M90 26 h5" {...ink} fill="none" />
          <path d="M-4 96 Q30 70 58 88 T104 82 V124 H-4Z" fill="#bfe8cf" {...ink} />
          <rect x="34" y="62" width="26" height="30" rx="10" fill="#cdb8f2" {...ink} />
          <circle cx="47" cy="50" r="13" fill="#ffd3b5" {...ink} />
          <circle cx="42.5" cy="48" r="1.7" fill="#15171d" /><circle cx="51.5" cy="48" r="1.7" fill="#15171d" />
          <path d="M42 55 q5 4 10 0" {...ink} fill="none" />
          <path d="M14 30 q6 -6 12 0 q6 -6 12 0" {...ink} fill="none" />
        </svg>
      );
    case "watercolor":
      return (
        <svg viewBox="0 0 100 120" aria-hidden="true">
          <defs>
            <filter id={`${id}w`} x="-20%" y="-20%" width="140%" height="140%">
              <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="3" seed="3" />
              <feDisplacementMap in="SourceGraphic" scale="7" />
              <feGaussianBlur stdDeviation="1.4" />
            </filter>
          </defs>
          <rect width="100" height="120" fill="#f8f2e7" />
          <g filter={ref("w")} opacity="0.85">
            <ellipse cx="45" cy="30" rx="58" ry="26" fill="#a9cbe8" />
            <circle cx="74" cy="28" r="12" fill="#f4b483" />
            <path d="M-6 92 Q28 66 60 84 T108 78 V126 H-6Z" fill="#9fc89b" />
            <ellipse cx="47" cy="74" rx="12" ry="16" fill="#e59aa4" />
            <circle cx="47" cy="52" r="10" fill="#f3cfb2" />
          </g>
          <path d="M37 56 q10 6 20 0 M30 95 q20 -8 40 0" stroke="#8a7f70" strokeWidth="0.6" fill="none" opacity="0.6" />
        </svg>
      );
    case "clay":
      return (
        <svg viewBox="0 0 100 120" aria-hidden="true">
          <defs>
            <radialGradient id={`${id}s`} cx="35%" cy="30%" r="75%"><stop offset="0" stopColor="#ffd9a0" /><stop offset="1" stopColor="#e8862f" /></radialGradient>
            <radialGradient id={`${id}h`} cx="40%" cy="20%" r="90%"><stop offset="0" stopColor="#b6e3a8" /><stop offset="1" stopColor="#4f9a4a" /></radialGradient>
            <radialGradient id={`${id}b`} cx="35%" cy="28%" r="80%"><stop offset="0" stopColor="#ffc2cf" /><stop offset="1" stopColor="#d9637d" /></radialGradient>
            <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f6e2d2" /><stop offset="1" stopColor="#e6bfa5" /></linearGradient>
            <filter id={`${id}d`}><feDropShadow dx="1.5" dy="3" stdDeviation="2" floodOpacity="0.35" /></filter>
          </defs>
          <rect width="100" height="120" fill={ref("g")} />
          <circle cx="75" cy="25" r="12" fill={ref("s")} filter={ref("d")} />
          <ellipse cx="50" cy="104" rx="66" ry="26" fill={ref("h")} filter={ref("d")} />
          <ellipse cx="48" cy="66" rx="17" ry="20" fill={ref("b")} filter={ref("d")} />
          <circle cx="42" cy="61" r="3.4" fill="#fff" /><circle cx="54" cy="61" r="3.4" fill="#fff" />
          <circle cx="42.8" cy="61.6" r="1.7" fill="#2a1f22" /><circle cx="54.8" cy="61.6" r="1.7" fill="#2a1f22" />
          <path d="M43 71 q5 4 10 0" stroke="#8c2f45" strokeWidth="2" strokeLinecap="round" fill="none" />
        </svg>
      );
    case "comic":
      return (
        <svg viewBox="0 0 100 120" aria-hidden="true">
          <defs>
            <pattern id={`${id}p`} width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.3" fill="#e9a70f" /></pattern>
          </defs>
          <rect width="100" height="120" fill="#ffd23f" />
          <rect width="100" height="120" fill={ref("p")} />
          <path d="M50 8 L56 26 L74 18 L64 34 L84 40 L64 46 L72 62 L54 52 L50 70 L44 52 L26 62 L34 46 L14 40 L34 34 L24 18 L42 26Z" fill="#fff" stroke="#111" strokeWidth="2.4" strokeLinejoin="round" />
          <path d="M-4 100 L30 80 L60 94 L104 76 V124 H-4Z" fill="#1d4ed8" stroke="#111" strokeWidth="3" strokeLinejoin="round" />
          <circle cx="50" cy="40" r="12" fill="#e63946" stroke="#111" strokeWidth="3" />
          <path d="M44 38 h3 M53 38 h3 M45 45 q5 3 10 0" stroke="#111" strokeWidth="2.4" strokeLinecap="round" fill="none" />
          <path d="M8 70 l14 4 M6 80 l16 0 M92 66 l-14 6" stroke="#111" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "flat":
      return (
        <svg viewBox="0 0 100 120" aria-hidden="true">
          <rect width="100" height="120" fill="#cfeee9" />
          <circle cx="72" cy="30" r="12" fill="#ff8a65" />
          <path d="M-6 100 L28 56 L58 100Z" fill="#2f5d62" />
          <path d="M30 100 L66 48 L106 100Z" fill="#3e8e7e" />
          <rect x="0" y="96" width="100" height="24" fill="#f7c873" />
          <rect x="18" y="84" width="16" height="14" fill="#e85d75" />
          <path d="M16 85 L26 76 L36 85Z" fill="#7b2d40" />
          <circle cx="80" cy="88" r="7" fill="#2f5d62" /><rect x="78.5" y="92" width="3" height="8" fill="#7b2d40" />
        </svg>
      );
    case "cinematic":
      return (
        <svg viewBox="0 0 100 120" aria-hidden="true">
          <defs>
            <linearGradient id={`${id}k`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0f1b33" /><stop offset="0.55" stopColor="#7c3d4d" /><stop offset="0.8" stopColor="#f2a35e" /></linearGradient>
            <radialGradient id={`${id}u`} cx="62%" cy="74%" r="45%"><stop offset="0" stopColor="#ffe3a3" stopOpacity="0.95" /><stop offset="1" stopColor="#ffe3a3" stopOpacity="0" /></radialGradient>
            <radialGradient id={`${id}v`} cx="50%" cy="50%" r="70%"><stop offset="0.55" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity="0.6" /></radialGradient>
          </defs>
          <rect width="100" height="120" fill={ref("k")} />
          <rect width="100" height="120" fill={ref("u")} />
          <path d="M-4 96 Q24 80 46 90 T104 84 V124 H-4Z" fill="#14100f" />
          <path d="M30 92 v-14 q4 -10 8 0 v14Z" fill="#14100f" />
          <circle cx="34" cy="74" r="4" fill="#14100f" />
          <rect width="100" height="120" fill={ref("v")} />
          <rect width="100" height="9" fill="#000" /><rect y="111" width="100" height="9" fill="#000" />
        </svg>
      );
    case "anime":
      return (
        <svg viewBox="0 0 100 120" aria-hidden="true">
          <defs>
            <linearGradient id={`${id}a`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3b82f6" /><stop offset="1" stopColor="#bfdbfe" /></linearGradient>
          </defs>
          <rect width="100" height="120" fill={ref("a")} />
          <path d="M8 46 q2 -12 14 -8 q4 -12 18 -6 q10 -6 16 4 q12 0 10 10Z" fill="#fff" />
          <path d="M14 44 q20 4 52 2 q0 4 -2 4 h-48Z" fill="#c7d9f5" />
          <path d="M-4 96 Q34 70 104 86 V124 H-4Z" fill="#4ade80" />
          <path d="M-4 104 Q40 84 104 96 V124 H-4Z" fill="#16a34a" />
          <path d="M78 18 l2 6 l6 2 l-6 2 l-2 6 l-2 -6 l-6 -2 l6 -2Z" fill="#fff" />
          <path d="M40 112 l6 -22 l6 22Z" fill="#1e3a8a" />
          <circle cx="46" cy="84" r="6" fill="#fde2cf" stroke="#1e293b" strokeWidth="1" />
          <path d="M40 82 q6 -10 12 0 q-6 -3 -12 0Z" fill="#1e293b" />
        </svg>
      );
  }
}

/** The picture style for every scene: a radio group of drawn samples (arrow keys move the choice). */
export function StoryStylePicker({ value, onChange }: { value: StoryStyle; onChange: (style: StoryStyle) => void }) {
  const radio = useRadioKeys(storyStyleIds, value, onChange);
  return (
    <div className="story-styles" role="radiogroup" aria-label="Picture style">
      {storyStyleIds.map((s, i) => (
        <button key={s} type="button" className="story-style" {...radio(s, i)} aria-label={`${storyStyles[s].name}: ${storyStyles[s].short}`}>
          <Sample style={s} />
          <span className="style-name">{storyStyles[s].name}</span>
        </button>
      ))}
    </div>
  );
}
