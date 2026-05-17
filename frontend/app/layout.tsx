import "./globals.css";
import Link from "next/link";

export const metadata = {
  title: "Vision Enterprise — Employee Portal",
  description: "AI-powered employee experience for onboarding and life events",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="brand">
            Vision Enterprise <small>Employee Portal</small>
          </div>
          <nav>
            <Link href="/">Portal</Link>
            <Link href="/admin">Admin Console</Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
