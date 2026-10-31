type Rect = { x: number; y: number; width: number; height: number };

function mapPoints<T extends { type: string }>(anns: T[], mx: (v: number) => number, my: (v: number) => number): T[] {
  const p = (pt: number[]) => [mx(pt[0]), my(pt[1])];
  return anns.map((a) => {
    const o = a as unknown as Record<string, unknown>;
    const r: Record<string, unknown> = { ...o };
    if (Array.isArray(o.bbox)) {
      const [x1, y1, x2, y2] = o.bbox as number[];
      r.bbox = [mx(x1), my(y1), mx(x2), my(y2)];
    }
    for (const k of ["from", "to", "at"]) if (Array.isArray(o[k])) r[k] = p(o[k] as number[]);
    return r as unknown as T;
  });
}

/** 窗口截图上的标注（相对窗口 0~1000）→ 所在显示器上的 0~1000。rect / display 同为 DIP 坐标 */
export function mapToDisplay<T extends { type: string }>(anns: T[], rect: Rect, display: Rect): T[] {
  return mapPoints(
    anns,
    (v) => ((rect.x - display.x + (v / 1000) * rect.width) / display.width) * 1000,
    (v) => ((rect.y - display.y + (v / 1000) * rect.height) / display.height) * 1000,
  );
}

/** mapToDisplay 的逆变换：显示器上的 0~1000 → 窗口内的 0~1000（可超出 0~1000，表示在窗口外） */
export function mapFromDisplay<T extends { type: string }>(anns: T[], rect: Rect, display: Rect): T[] {
  return mapPoints(
    anns,
    (v) => ((display.x + (v / 1000) * display.width - rect.x) / rect.width) * 1000,
    (v) => ((display.y + (v / 1000) * display.height - rect.y) / rect.height) * 1000,
  );
}
