/* The ReqOps brand mark: a single open loop tilted -34deg, with an anchor node
   (the last decision held in view) and a head node (the live edge). State is
   signalled by motion, never by recolouring — the head warms to amber only on
   a genuine capture. Ported from reqops-governance/src/design-system. */
export function ReqopsMark({ size = 20, className = "" }) {
  const loop = "M 33.04 22.86 A 32 32 0 1 0 66.96 22.86";
  return (
    <svg
      className={`rq-svg ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
    >
      <path className="rq-ghost" d={loop} strokeWidth={7.5} />
      <path className="rq-trail" d={loop} strokeWidth={7.5} />
      <circle className="rq-anchor" cx={33.04} cy={22.86} r={5.4} />
      <circle className="rq-head" cx={66.96} cy={22.86} r={8} />
    </svg>
  );
}

/* Mark + wordmark lockup. `variant` picks the spacing: "bar" in the app header,
   "gate" above a centred card screen. */
export function ReqopsLockup({ variant = "bar", size = 20 }) {
  return (
    <div className={variant === "gate" ? "gate-mark" : "wordmark"}>
      <ReqopsMark size={size} />
      <span>ReqOps</span>
    </div>
  );
}
