import { useEffect, useRef, type ReactNode } from "react";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  LoaderCircle,
  X,
} from "lucide-react";
import { assets, rankImage } from "./assets";
export function Spinner() {
  return <LoaderCircle className="spinner" size={19} aria-hidden="true" />;
}
export function Feedback({
  error,
  notice,
  retry,
}: {
  error?: string;
  notice?: string;
  retry?: () => void;
}) {
  return (
    <>
      {error && (
        <div className="feedback error" role="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
          {retry && (
            <button className="text-button" onClick={retry}>
              Retry
            </button>
          )}
        </div>
      )}
      {notice && (
        <div className="feedback success" role="status">
          <Check size={17} />
          <span>{notice}</span>
        </div>
      )}
    </>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}
export function PageTitle({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-title">
      <div>
        <h1 tabIndex={-1}>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <div className="actions">{children}</div>
    </header>
  );
}
export function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const focused = document.activeElement as HTMLElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      focused?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "wide" : ""}
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          const r = ref.current!.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dialog-head">
        <h2 id="dialog-title">{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
export function Avatar({
  name = "",
  icon = "blue",
  rank,
  size = 48,
}: {
  name?: string | undefined;
  icon?: string | undefined;
  rank?: unknown;
  size?: number;
}) {
  const src =
    icon === "portrait"
      ? assets.avatar
      : icon === "rank"
        ? rankImage(rank) || assets.avatar
        : undefined;
  return (
    <span className={`avatar ${icon}`} style={{ width: size, height: size }}>
      {src ? <img src={src} alt="" /> : name.slice(0, 1).toUpperCase() || "B"}
    </span>
  );
}
export function Pager({
  offset,
  total,
  limit,
  onChange,
  busy = false,
}: {
  offset: number;
  total: number;
  limit: number;
  onChange: (offset: number) => void;
  busy?: boolean;
}) {
  return total > 0 ? (
    <div className="pager">
      <span>
        {offset + 1}–{Math.min(offset + limit, total)} of {total}
      </span>
      <button
        className="icon-button"
        aria-label="Previous page"
        disabled={busy || offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        <ChevronLeft size={19} />
      </button>
      <button
        className="icon-button"
        aria-label="Next page"
        disabled={busy || offset + limit >= total}
        onClick={() => onChange(offset + limit)}
      >
        <ChevronRight size={19} />
      </button>
    </div>
  ) : null;
}
export function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const ref = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(ref.current), []);
  return (
    <button
      className="secondary"
      onClick={async (e) => {
        const button = e.currentTarget;
        try {
          await navigator.clipboard.writeText(value);
          button.dataset.copied = "true";
          clearTimeout(ref.current);
          ref.current = window.setTimeout(() => {
            delete button.dataset.copied;
          }, 1800);
        } catch {
          button.title = "Select and copy the code manually.";
        }
      }}
    >
      <Copy size={15} />
      <span className="copy-label">{label}</span>
      <span className="copied-label">Copied</span>
    </button>
  );
}
