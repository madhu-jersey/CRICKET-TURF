import { ogCard } from "@/lib/og";

export const alt = "Book a box cricket or pickleball slot";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return ogCard("Book a slot", "Live availability · pay a small advance · WhatsApp confirmation");
}
