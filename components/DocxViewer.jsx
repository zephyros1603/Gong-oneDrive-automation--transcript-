'use client';

/**
 * components/DocxViewer.jsx — a .docx, rendered read-only.
 *
 * react-doc-viewer's default export does not come with its renderers already
 * attached — omitting `pluginRenderers` answers every file with "No Renderer
 * for file type X", even though the renderer for that exact type is sitting
 * right there in the package. `DocViewerRenderers` has to be imported and
 * passed explicitly.
 *
 * Both are loaded inside one `next/dynamic` wrapper rather than two separate
 * calls, because `DocViewerRenderers` is a plain array, not a component —
 * wrapping *that* in `dynamic()` produces a component where an array was
 * expected.
 */

import dynamic from 'next/dynamic';

const LazyDocViewer = dynamic(async () => {
  const { default: DocViewer, DocViewerRenderers } = await import('react-doc-viewer');
  return function BoundDocViewer(props) {
    return <DocViewer {...props} pluginRenderers={DocViewerRenderers} />;
  };
}, { ssr: false });

export function DocxViewer({ uri, fileName }) {
  return (
    <div className="h-full min-h-[520px] overflow-hidden rounded-xl border border-border">
      {/* `fileType` is what actually selects a renderer — the package's
          `IDocument` has no `fileName` field at all, so passing one there
          silently did nothing; the URL itself (a `/api/file?path=...` query
          string with no `.docx` of its own) gave the renderer-matcher
          nothing to go on either. */}
      <LazyDocViewer
        documents={[{ uri, fileType: 'docx' }]}
        config={{ header: { disableHeader: false, disableFileName: false, retainURLParams: false } }}
        style={{ height: '100%' }}
      />
    </div>
  );
}

export default DocxViewer;
