import { useEffect } from "react";

/* The REQOPS lockup from the design system: the open ring (top quarter open,
   turned -32deg) and REQOPS in mono, with the product name in muted ink.
   `variant` picks the spacing: "bar" in the app header, "gate" above a
   centred card screen. */
export function ReqopsLockup({ variant = "bar" }) {
  return (
    <span className={`wordmark ${variant === "gate" ? "gate-mark" : ""}`.trim()} aria-label="REQOPS Assessment">
      <span className="ring" aria-hidden="true" />
      <span aria-hidden="true">REQOPS <span className="product">ASSESSMENT</span></span>
    </span>
  );
}

/* Candidate-facing lockup. Under an employer it shows their logo (or name when
   there is no logo); without one it falls back to the REQOPS lockup. */
export function BrandLockup({ employer, variant = "bar" }) {
  if (!employer) return <ReqopsLockup variant={variant} />;
  return (
    <span className={`wordmark employer-mark ${variant === "gate" ? "gate-mark" : ""}`.trim()}>
      {employer.logo
        ? <img src={employer.logo} alt={employer.name} style={{ height: variant === "gate" ? 38 : 30 }} />
        : <span>{employer.name}</span>}
    </span>
  );
}

/* Sets the employer's colour as --brand for the top stripe, and the tab title. */
export function useEmployerBrand(employer, title = "Assessment") {
  useEffect(() => {
    const root = document.documentElement;
    if (employer?.brandColor) root.style.setProperty("--brand", employer.brandColor);
    else root.style.removeProperty("--brand");
    root.dataset.employer = employer ? "true" : "false";
    document.title = `${employer?.name || "REQOPS"} — ${title}`;
  }, [employer?.name, employer?.brandColor, title]);
}
