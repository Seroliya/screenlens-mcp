import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Annotation, ShotRef } from "../../shared/types";
import { drawAnnotations } from "../../shared/draw";
import { shotUrl } from "../lib/shot-url";

/** 截图 + SVG 标注层。标注按图片实际显示尺寸绘制，缩略图里线条自动变细。 */
export function AnnotatedImage({
  shot,
  anns,
  animate,
  className,
  onClick,
}: {
  shot: ShotRef;
  anns?: Annotation[];
  animate?: boolean;
  className?: string;
  onClick?: () => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const ro = new ResizeObserver(() => setSize({ w: img.clientWidth, h: img.clientHeight }));
    ro.observe(img);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!svgRef.current || !size.w || !size.h) return;
    drawAnnotations(svgRef.current, anns ?? [], {
      width: size.w,
      height: size.h,
      scale: Math.max(0.42, Math.min(1.2, size.w / 900)),
      animate,
      compact: size.w < 260,
    });
  }, [size.w, size.h, anns, animate]);

  return (
    <div className={`annimg ${className ?? ""} ${onClick ? "clickable" : ""}`} onClick={onClick}>
      <img
        ref={imgRef}
        src={shotUrl(shot.id)}
        draggable={false}
        alt={shot.label ?? ""}
        onLoad={(e) => setSize({ w: e.currentTarget.clientWidth, h: e.currentTarget.clientHeight })}
      />
      <svg ref={svgRef} />
    </div>
  );
}
