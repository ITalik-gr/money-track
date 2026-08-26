import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n/index.ts";
import { Icon } from "../ui/Icon.tsx";

export type Shot = { src: string; w: number; h: number; alt: string; cap: string };

/**
 * Full-screen viewer for the landing's screenshots.
 *
 * The screenshots are whole product screens shrunk into a 500px tile — legible as a shape, not as
 * a screen. Being able to open one is what makes the gallery worth having at all, so this is the
 * one piece of behaviour the marketing page owns.
 *
 * ⚠️ **Written here rather than installed.** A lightbox package is 15–40 KB in a bundle every
 * signed-in user downloads for a page they will never see again, and the parts that justify one —
 * pinch-zoom, thumbnails, slideshow, video — are not on this page. What is actually needed is 60
 * lines: an overlay, arrows, and the three ways out a viewer expects (Esc, the backdrop, the
 * button). Reconsider the moment this wants zooming.
 *
 * ⚠️ **It renders through a PORTAL, into `document.body`.** An overlay that lives inside the page
 * it covers is one ancestor away from being clipped or re-stacked at any time — this one WAS: a
 * blanket `z-index` rule on the landing's children overrode its `position: fixed`, and it quietly
 * rendered as a block at the bottom of the document. Clicking a screenshot appeared to do nothing
 * except lock the scroll, because the one visible effect was the scroll lock.
 *
 * ⚠️ **Scrolling is locked on BODY, not on `html`.** `html, body { height: 100% }` plus
 * `body { overflow-x: hidden }` makes BODY the scrolling box in this app — the same fact that
 * makes fragment links inert on the landing (see `jumpTo` in `Landing.tsx`). Setting
 * `documentElement.style.overflow` here would look right and do nothing.
 */
export function Lightbox({
  shots,
  index,
  onClose,
  onIndex,
}: {
  shots: Shot[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  const t = useT();
  const shot = shots[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") onIndex((index + 1) % shots.length);
      if (e.key === "ArrowLeft") onIndex((index - 1 + shots.length) % shots.length);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflowY;
    document.body.style.overflowY = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflowY = prev;
    };
  }, [index, shots.length, onClose, onIndex]);

  if (!shot) return null;

  return createPortal(
    // The backdrop closes; anything inside it must not, hence the stopPropagation on the frame.
    <div className="lp-lb" role="dialog" aria-modal="true" aria-label={shot.alt} onClick={onClose}>
      <button type="button" className="lp-lb-x" onClick={onClose} aria-label={t("landing.lbClose")}>
        <Icon name="plus" size={20} />
      </button>
      {shots.length > 1 && (
        <button
          type="button"
          className="lp-lb-nav prev"
          aria-label={t("landing.lbPrev")}
          onClick={(e) => { e.stopPropagation(); onIndex((index - 1 + shots.length) % shots.length); }}
        >
          <Icon name="chevron" size={20} />
        </button>
      )}
      <figure className="lp-lb-frame" onClick={(e) => e.stopPropagation()}>
        {/* Native size caps at the viewport: these are 2200px wide, and a viewer that has to be
            scrolled sideways to read a screenshot is worse than the tile it was opened from. */}
        <img src={shot.src} width={shot.w} height={shot.h} alt={shot.alt} />
        <figcaption>
          {shot.cap}
          {shots.length > 1 && <span className="lp-lb-count">{index + 1} / {shots.length}</span>}
        </figcaption>
      </figure>
      {shots.length > 1 && (
        <button
          type="button"
          className="lp-lb-nav next"
          aria-label={t("landing.lbNext")}
          onClick={(e) => { e.stopPropagation(); onIndex((index + 1) % shots.length); }}
        >
          <Icon name="chevron" size={20} />
        </button>
      )}
    </div>,
    document.body,
  );
}
