/**
 * Monitored provisioning.
 *
 * Deliberately empty. The tab and its route exist so the navigation is
 * settled and nothing has to move later; what goes in it is still to be
 * specified, and guessing at a data model now would only have to be undone.
 */
export default function ProvisioningPage() {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-[420px] text-center">
        <div className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded-xl
                        border border-[var(--line)] bg-[var(--surface-2)]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)"
               strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v4M12 18v4M4.9 4.9l2.9 2.9M16.2 16.2l2.9 2.9M2 12h4M18 12h4M4.9 19.1l2.9-2.9M16.2 7.8l2.9-2.9" />
          </svg>
        </div>
        <h1 className="mb-2 text-[15px] font-semibold">Monitored provisioning</h1>
        <p className="text-[12.5px] leading-relaxed text-[var(--muted)]">
          Nothing here yet — this tab is a placeholder held open on purpose, so the
          navigation and routing are settled before the feature is designed.
        </p>
      </div>
    </div>
  );
}
