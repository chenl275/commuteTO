import type { SVGProps } from "react";

interface Building {
  x: number;
  width: number;
  height: number;
}

const GROUND_Y = 260;

const buildings: Building[] = [
  { x: 0, width: 70, height: 90 },
  { x: 75, width: 50, height: 130 },
  { x: 130, width: 60, height: 70 },
  { x: 195, width: 40, height: 160 },
  { x: 240, width: 70, height: 100 },
  { x: 315, width: 55, height: 190 },
  { x: 375, width: 45, height: 120 },
  { x: 425, width: 65, height: 150 },
  { x: 495, width: 50, height: 210 },
  { x: 550, width: 40, height: 100 },
  { x: 595, width: 60, height: 170 },
  // gap here for the CN Tower
  { x: 730, width: 55, height: 190 },
  { x: 790, width: 45, height: 130 },
  { x: 840, width: 65, height: 220 },
  { x: 910, width: 50, height: 150 },
  { x: 965, width: 60, height: 100 },
  { x: 1030, width: 45, height: 180 },
  { x: 1080, width: 70, height: 140 },
  { x: 1155, width: 50, height: 200 },
  { x: 1210, width: 60, height: 110 },
  { x: 1275, width: 45, height: 160 },
  { x: 1325, width: 65, height: 90 },
  { x: 1395, width: 45, height: 130 },
];

/**
 * A stylized Toronto skyline, CN Tower included, used as a decorative
 * silhouette. Purely presentational, so it's hidden from assistive tech.
 */
export default function SkylineSilhouette(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 1440 260"
      preserveAspectRatio="none"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      {buildings.map((building) => (
        <rect
          key={building.x}
          x={building.x}
          y={GROUND_Y - building.height}
          width={building.width}
          height={building.height}
        />
      ))}

      {/* CN Tower */}
      <rect x="686" y="14" width="3" height="18" />
      <rect x="683" y="32" width="9" height="180" />
      <ellipse cx="687.5" cy="98" rx="24" ry="10" />
      <path d="M665 212 L710 212 L700 260 L675 260 Z" />
    </svg>
  );
}
