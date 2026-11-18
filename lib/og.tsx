import { ImageResponse } from "next/og";
import { siteConfig } from "@/config/site";

const size = { width: 1200, height: 630 };

/** Shared Open Graph card. Pages inherit it; /book and /gallery re-export it with their own title. */
export function ogCard(title: string, subtitle: string) {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: 72, background: "linear-gradient(160deg, #0b2a19 0%, #03100a 70%)", color: "#f3f6f1", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", fontSize: 28, letterSpacing: 6, color: "#d6ff3d", textTransform: "uppercase" }}>{siteConfig.name}</div>
        <div style={{ display: "flex", fontSize: 96, fontWeight: 800, lineHeight: 1, marginTop: 16, textTransform: "uppercase" }}>{title}</div>
        <div style={{ display: "flex", fontSize: 34, marginTop: 24, color: "#a9bbae" }}>{subtitle}</div>
        <div style={{ display: "flex", position: "absolute", top: 60, right: 72, width: 140, height: 140, borderRadius: 999, background: "#d6ff3d", opacity: 0.9 }} />
      </div>
    ),
    size,
  );
}

