/**
 * Геометрия экспорта ER-диаграммы: без DOM, чтобы проверяться в node.
 *
 * @module metadataErCanvas/geometry
 */

/** Прямоугольник узла в координатах диаграммы. */
export interface NodeBox {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * Точка, где луч из центра прямоугольника к другой точке выходит за его край.
 *
 * @param box Прямоугольник узла
 * @param toward Точка, куда смотрит луч
 */
export function boxExit(box: NodeBox, toward: { x: number; y: number }): { x: number; y: number } {
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const dx = toward.x - cx;
	const dy = toward.y - cy;
	if (dx === 0 && dy === 0) {
		return { x: cx, y: cy };
	}
	const scale = Math.min(
		dx === 0 ? Infinity : box.width / 2 / Math.abs(dx),
		dy === 0 ? Infinity : box.height / 2 / Math.abs(dy)
	);
	return { x: cx + dx * Math.min(scale, 1), y: cy + dy * Math.min(scale, 1) };
}
