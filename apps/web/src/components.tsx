import {
  useEffect,
  useRef,
  useId,
  isValidElement,
  cloneElement,
  type ReactNode,
  type ReactElement,
} from "react";
import tones from "./product-tones.json";
import type { Product } from "../../../packages/contracts/index.ts";
export function Dialog({
  title,
  close,
  children,
  wide = false,
  returnFocus,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
  returnFocus?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = returnFocus ?? (document.activeElement as HTMLElement);
    const dialog = ref.current;
    dialog?.showModal();
    const focus =
      dialog?.querySelector<HTMLElement>(
        'input[aria-label="Cash received"], input, select, textarea',
      ) ?? dialog?.querySelector<HTMLElement>("button");
    focus?.focus();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, [title]);
  return (
    <dialog
      ref={ref}
      className={wide ? "wide" : ""}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <header className="dialog-head">
        <h2>{title}</h2>
        <button type="button" aria-label="Close dialog" onClick={close}>
          ×
        </button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const labelId = useId();
  const control = isValidElement(children)
    ? (children as ReactElement<Record<string, unknown>>)
    : null;
  return (
    <label className="field">
      <span id={labelId}>{label}</span>
      {control &&
      !control.props["aria-label"] &&
      !control.props["aria-labelledby"]
        ? cloneElement(control, { "aria-labelledby": labelId })
        : children}
    </label>
  );
}
export function ProductArt({ product }: { product: Product }) {
  if (product.sku in tones)
    return (
      <img
        className="product-art"
        src={"/products/" + product.sku + ".svg"}
        alt=""
      />
    );
  const packet = ["Snacks", "Bakery"].includes(product.category_name);
  const color =
    product.category_name === "Drinks"
      ? "#7BA49C"
      : product.category_name === "Snacks"
        ? "#BB8952"
        : product.category_name === "Bakery"
          ? "#D5A15D"
          : "#8093AD";
  return (
    <svg className="product-art" viewBox="0 0 160 120" aria-hidden="true">
      <ellipse cx="80" cy="105" rx="35" ry="6" fill="#152D35" opacity=".12" />
      {packet ? (
        <>
          <path d="M51 19H109L104 97H56Z" fill={color} />
          <path d="M51 19H109V30H51Z" fill="#614D34" />
          <rect x="57" y="45" width="46" height="31" rx="3" fill="#FFF9EC" />
          <circle cx="80" cy="60" r="11" fill="#BB8952" />
          <circle cx="76" cy="57" r="2" fill="#614D34" />
          <circle cx="85" cy="63" r="2" fill="#614D34" />
        </>
      ) : (
        <>
          <rect x="67" y="13" width="26" height="12" rx="4" fill="#354F53" />
          <path
            d="M63 25H97L105 42V94Q105 101 98 101H62Q55 101 55 94V42Z"
            fill={color}
          />
          <rect x="55" y="51" width="50" height="29" rx="3" fill="#FFF9EC" />
          <path d="M80 55Q97 68 80 75Q63 68 80 55" fill={color} />
          <path d="M61 43V89" stroke="#FFF" opacity=".3" strokeWidth="5" />
        </>
      )}
    </svg>
  );
}
export function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <span aria-hidden="true">◇</span>
      <p>{text}</p>
    </div>
  );
}
export function download(name: string, data: Blob) {
  const url = URL.createObjectURL(data),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
