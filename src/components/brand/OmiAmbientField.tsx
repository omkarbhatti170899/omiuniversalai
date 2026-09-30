/**
 * OMI — ambient field.
 * =============================================================================
 * The only decorative motion Omi allows on a full-bleed surface, and it is
 * deliberately almost invisible: a handful of nodes and the lines between
 * neighbours, drifting once every 40+ seconds.
 *
 * DESIGN CONSTRAINTS (all deliberate, all reversible in one file):
 *   • No JS animation loop. The drift is a single CSS/framer transform on a
 *     static SVG, so it costs one composited layer and zero main-thread time.
 *   • Fixed node positions, not Math.random in render — a random layout would
 *     reshuffle on every re-render and read as noise.
 *   • Capped opacity (~0.5 max on strokes) and a radial mask so it fades out
 *     before it reaches content. It must never compete with the logo.
 *   • Fully disabled under prefers-reduced-motion, and it never intercepts
 *     pointer events, so it can never delay a click.
 */

import { motion, useReducedMotion } from "framer-motion";
import { useMemo } from "react";
import { cn } from "@/lib/utils";

type Node = { x: number; y: number; r: number };

/** Hand-placed so the composition has a clear centre and quiet edges. */
const NODES: Node[] = [
  { x: 120, y: 150, r: 2.2 },
  { x: 300, y: 90, r: 1.6 },
  { x: 470, y: 190, r: 2.6 },
  { x: 620, y: 110, r: 1.4 },
  { x: 780, y: 230, r: 2.0 },
  { x: 200, y: 330, r: 1.8 },
  { x: 420, y: 300, r: 2.4 },
  { x: 660, y: 380, r: 1.6 },
  { x: 860, y: 330, r: 2.2 },
  { x: 90, y: 470, r: 1.5 },
  { x: 330, y: 520, r: 2.0 },
  { x: 560, y: 470, r: 1.7 },
  { x: 790, y: 540, r: 2.3 },
];

/** Connect neighbours only — a real network, not a hairball. */
function edges(nodes: Node[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < nodes.length; i++) {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best >= 0 && bestD < 260) out.push([i, best]);
  }
  return out;
}

export function OmiAmbientField({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  const links = useMemo(() => edges(NODES), []);

  return (
    <motion.div
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
      initial={reduce ? false : { opacity: 0 }}
      animate={reduce ? undefined : { opacity: 1 }}
      transition={{ duration: 1.6, ease: "easeOut" }}
    >
      {/* Base wash: two very low-opacity blooms, matching .omi-ambient. */}
      <div className="omi-ambient absolute inset-0" />

      <svg
        viewBox="0 0 960 600"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 size-full"
        style={{
          maskImage: "radial-gradient(70% 60% at 50% 45%, black 20%, transparent 78%)",
          WebkitMaskImage: "radial-gradient(70% 60% at 50% 45%, black 20%, transparent 78%)",
        }}
      >
        <motion.g
          animate={reduce ? undefined : { x: [0, 14, 0], y: [0, -10, 0] }}
          transition={reduce ? undefined : { duration: 46, repeat: Infinity, ease: "easeInOut" }}
        >
          {links.map(([a, b], i) => (
            <line
              key={`l${i}`}
              x1={NODES[a].x}
              y1={NODES[a].y}
              x2={NODES[b].x}
              y2={NODES[b].y}
              stroke="currentColor"
              className="text-primary"
              strokeOpacity={0.16}
              strokeWidth={1}
            />
          ))}
          {NODES.map((n, i) => (
            <circle
              key={`n${i}`}
              cx={n.x}
              cy={n.y}
              r={n.r}
              fill="currentColor"
              className="text-primary"
              fillOpacity={0.34}
            />
          ))}
        </motion.g>
      </svg>
    </motion.div>
  );
}
