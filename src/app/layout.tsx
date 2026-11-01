import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Slot Design · Learning workspace', description: 'Course materials, homework and expert feedback.', robots: { index: false, follow: false } };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
