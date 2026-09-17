import './globals.css';
import AppShell from '@/components/AppShell.jsx';
import { themeScript } from '@/components/ThemeToggle.jsx';

export const metadata = {
  title: 'Warp',
  description: 'Turn calls into documents, and keep your systems of record current.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before first paint, or the light theme flashes and snaps to dark. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="h-full overflow-hidden">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
