import { ogCard } from "@/lib/og";

export const alt = "Photos of the arena";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return ogCard("Gallery", "Floodlit turf, pickleball courts and facilities");
}
