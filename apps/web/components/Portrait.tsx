"use client";

import { useEffect, useState, type CSSProperties } from "react";

/**
 * The customer's face, from /public/leads/<id>.jpg, with their initials in its
 * place for any lead that has no portrait on disk - which is what CIMET's real
 * leads will be. The portraits are generated stand-ins for synthetic leads,
 * never photographs of anyone.
 */
export function Portrait({
  id,
  name,
  size = 40,
  className = "",
}: {
  id: string | null | undefined;
  name: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  // A different lead gets a fresh attempt at its own file.
  useEffect(() => {
    setFailed(false);
  }, [id]);

  const style = { "--portrait-size": `${size}px` } as CSSProperties;
  const classes = `portrait ${className}`.trim();

  if (!id || failed) {
    return (
      <span className={`${classes} portrait-initials`} style={style} aria-hidden="true">
        {initialsOf(name)}
      </span>
    );
  }
  return (
    <img
      className={classes}
      src={`/leads/${id}.jpg`}
      alt=""
      width={size}
      height={size}
      style={style}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "C"
  );
}
