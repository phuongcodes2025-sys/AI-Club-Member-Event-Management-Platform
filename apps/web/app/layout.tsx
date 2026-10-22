import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Club · Your community, connected",
  description: "Discover AI Club events, manage your participation, and build what comes next.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
