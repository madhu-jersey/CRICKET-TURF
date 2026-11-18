/**
 * All branding lives here. Swap these values (and the image URLs) to rebrand the site.
 * Business details that the owner can edit at runtime (address, phone, map link) are
 * also stored in the Settings table; these values are the defaults used by the seed.
 */
const unsplash = (id: string) => `https://images.unsplash.com/photo-${id}`;

export const siteConfig = {
  name: "Boundary Box Arena",
  shortName: "BBA",
  bookingCodePrefix: "BBA",
  tagline: "Box cricket & pickleball under the floodlights",
  description:
    "Book box cricket and pickleball courts in Bhimavaram. Floodlit turf, live slot availability, instant confirmation on WhatsApp.",
  city: "Bhimavaram",
  region: "Andhra Pradesh",
  postalCode: "534201",
  country: "IN",
  streetAddress: "Near Bypass Road, Bhimavaram",
  phoneE164: "+919000000000",
  phoneDisplay: "+91 90000 00000",
  whatsappNumber: "919000000000",
  email: "hello@boundaryboxarena.example",
  geo: { lat: 16.5449, lng: 81.5212 },
  mapLink: "https://maps.google.com/?q=16.5449,81.5212",
  mapEmbedUrl: "https://www.google.com/maps?q=16.5449,81.5212&z=15&output=embed",
  directionsUrl: "https://www.google.com/maps/dir/?api=1&destination=16.5449,81.5212",
  social: {
    instagram: "https://instagram.com/",
    facebook: "https://facebook.com/",
    youtube: "https://youtube.com/",
  },
  currency: "INR",
  timezone: "Asia/Kolkata",
  images: {
    hero: unsplash("1540747913346-19e32dc3e97e"),
    cricketCard: unsplash("1624526267942-ab0ff8a3e972"),
    pickleballCard: unsplash("1693142518820-78d7a05f1546"),
    howItWorks: unsplash("1529900748604-07564a03e7a6"),
    og: unsplash("1540747913346-19e32dc3e97e"),
  },
  /** Seed gallery. Admins can upload their own photos from /admin/gallery. */
  gallery: [
    { url: unsplash("1540747913346-19e32dc3e97e"), category: "CRICKET", alt: "Floodlit cricket ground at night", featured: true },
    { url: unsplash("1624526267942-ab0ff8a3e972"), category: "CRICKET", alt: "Batter playing a drive in front of the stumps", featured: true },
    { url: unsplash("1693142518820-78d7a05f1546"), category: "PICKLEBALL", alt: "Two pickleball paddles and yellow balls by the net", featured: true },
    { url: unsplash("1589801258579-18e091f4ca26"), category: "CRICKET", alt: "Batter driving the ball on a green outfield", featured: true },
    { url: unsplash("1595435934249-5df7ed86e1c0"), category: "PICKLEBALL", alt: "Player resting on a blue hard court with balls", featured: true },
    { url: unsplash("1529900748604-07564a03e7a6"), category: "FACILITIES", alt: "Fresh artificial turf with white boundary lines", featured: true },
    { url: unsplash("1531415074968-036ba1b575da"), category: "CRICKET", alt: "Red leather cricket ball resting on grass", featured: false },
    { url: unsplash("1626224583764-f87db24ac4ea"), category: "PICKLEBALL", alt: "Player leaping for an overhead shot on an indoor court", featured: false },
    { url: unsplash("1622279457486-62dcc4a431d6"), category: "PICKLEBALL", alt: "Player hitting a forehand on an outdoor court", featured: false },
    { url: unsplash("1512719994953-eabf50895df7"), category: "FACILITIES", alt: "Stadium stands under a pink evening sky", featured: false },
    { url: unsplash("1577223625816-7546f13df25d"), category: "FACILITIES", alt: "Players' tunnel leading out to the ground", featured: false },
    { url: unsplash("1459865264687-595d652de67e"), category: "FACILITIES", alt: "Close-up of turf and a painted white line", featured: false },
  ] as const,
  sports: {
    CRICKET: {
      slug: "cricket",
      label: "Box Cricket",
      courtSize: "100 ft × 60 ft netted box",
      players: "6–8 a side",
      blurb: "Full-netted box with premium 40 mm turf, bowling crease markings and LED floodlights.",
    },
    PICKLEBALL: {
      slug: "pickleball",
      label: "Pickleball",
      courtSize: "2 courts, 44 ft × 20 ft each",
      players: "2–4 players",
      blurb: "Two cushioned acrylic courts with tournament nets. Paddles and balls available on rent.",
    },
  },
  amenities: [
    { title: "LED floodlights", text: "Match-bright lighting till 11 PM." },
    { title: "Free parking", text: "Space for 40 bikes and 15 cars." },
    { title: "Drinking water", text: "RO-purified water, free for players." },
    { title: "Washrooms", text: "Clean washrooms and a changing area." },
    { title: "Equipment on rent", text: "Bats, balls, paddles and stumps." },
    { title: "Seating", text: "Shaded seating for friends and family." },
  ],
  faqs: [
    {
      q: "How much do I pay online?",
      a: "Only a small advance to hold your slot. The rest is paid at the venue by cash or UPI. The exact split is shown before you pay.",
    },
    {
      q: "Can I cancel my booking?",
      // Answer is generated from Settings by lib/policy (see the home page FAQ).
      a: "POLICY",
    },
    {
      q: "Do you provide equipment?",
      a: "Bats, tennis balls, stumps, pickleball paddles and balls are available on rent at the counter.",
    },
    {
      q: "What happens if it rains?",
      a: "If the venue is unplayable we will reschedule your slot or refund your advance in full.",
    },
    {
      q: "Can I book more than one hour?",
      a: "Yes. Select two or more back-to-back slots in the slot grid and they will be booked together.",
    },
  ],
} as const;

export type SportKey = keyof typeof siteConfig.sports;
export type GalleryCategory = "CRICKET" | "PICKLEBALL" | "FACILITIES";
