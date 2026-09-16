import './globals.css';
import TopBar from '@/components/TopBar.jsx';

export const metadata = {
  title: 'Gong Transcripts',
  description: 'Pull Gong call transcripts and turn them into client documents.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="flex h-full flex-col overflow-hidden">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </body>
    </html>
  );
}
