import { X } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef } from "react";

interface DetailDialogProps {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}

export function DetailDialog({
  title,
  eyebrow,
  children,
  onClose,
  wide = false
}: DetailDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = `detail-title-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      // Unmounting an open dialog does not consistently restore browser focus.
      // Wait until React has removed it, then return keyboard users to its opener.
      queueMicrotask(() => {
        if (opener?.isConnected && !document.querySelector("dialog[open]")) {
          opener.focus({ preventScroll: true });
        }
      });
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={`detail-dialog${wide ? " detail-dialog--wide" : ""}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="detail-inner">
        <header className="detail-header">
          <div>
            {eyebrow && <span className="detail-eyebrow">{eyebrow}</span>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="detail-close" type="button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
