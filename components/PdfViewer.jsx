'use client';

/**
 * components/PdfViewer.jsx — a PDF, rendered in the browser.
 *
 * `@pdf-viewer/react` is view-only here — no `licenseKey` is configured, so
 * this runs on whatever the package allows unlicensed. Worth knowing: its own
 * package.json calls it deprecated, pointing at a commercial successor
 * (react-pdf-kit.dev). It still works — the code shipped is real — but it is
 * not receiving updates, which is the kind of thing to reconsider before
 * this becomes load-bearing.
 */

import dynamic from 'next/dynamic';

const RPProvider = dynamic(() => import('@pdf-viewer/react').then((m) => m.RPProvider), { ssr: false });
const RPDefaultLayout = dynamic(() => import('@pdf-viewer/react').then((m) => m.RPDefaultLayout), { ssr: false });
const RPConfig = dynamic(() => import('@pdf-viewer/react').then((m) => m.RPConfig), { ssr: false });

export function PdfViewer({ src }) {
  return (
    <div className="h-full min-h-[520px] overflow-hidden rounded-xl border border-border bg-muted/30">
      <RPConfig>
        {/* pdf.js renders in a Worker; without workerUrl it fails to load one
            silently — no page error, just an empty canvas under a working
            toolbar, which is exactly what shipping without this looked like. */}
        <RPProvider src={src} workerUrl="/pdf.worker.min.mjs">
          <RPDefaultLayout style={{ height: '100%' }} />
        </RPProvider>
      </RPConfig>
    </div>
  );
}

export default PdfViewer;
