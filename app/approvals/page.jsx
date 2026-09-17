import { SealCheck } from '@phosphor-icons/react/dist/ssr';

/**
 * Approvals — the review queue.
 *
 * Deliberately empty. This is where generated output will be reviewed before
 * it reaches a client or a system of record; the argument for why that review
 * step has to exist is in docs/product-notes.md. Nothing is designed into it
 * until the workflow engine produces something to approve.
 */
export default function ApprovalsPage() {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-[440px] text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl border
                        border-border bg-card text-primary shadow-sm">
          <SealCheck size={22} weight="duotone" />
        </div>
        <h2 className="mb-2 text-[15px] font-semibold">Approvals</h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Generated documents and system-of-record updates will queue here for review
          before they go out. Nothing to approve yet — this arrives with the workflow
          engine.
        </p>
      </div>
    </div>
  );
}
