import type { Metadata } from "next";
import { MyBookings } from "@/components/booking/my-bookings";

export const metadata: Metadata = {
  title: "My bookings",
  description: "Verify your phone number to see and manage your upcoming and past bookings.",
  alternates: { canonical: "/my-bookings" },
};

export default function MyBookingsPage() {
  return (
    <div className="floodlit min-h-[70vh]">
      <div className="mx-auto max-w-2xl px-4 pb-16 pt-8 sm:px-6 sm:pt-12">
        <h1 className="font-display text-5xl font-extrabold uppercase">My bookings</h1>
        <p className="mb-8 mt-2 text-mist">Verify your phone to see your upcoming and past slots.</p>
        <MyBookings />
      </div>
    </div>
  );
}
