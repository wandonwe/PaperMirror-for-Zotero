/**
 * 几何安全验证 — 排版后的整页复核阶段(1.1.0 目标架构第 5 步,流水线末端
 * 唯一的新增阶段;方案审核结论)。
 *
 * 现状是"排版时避让"(computeExpansionAllowance 只看遮挡物的最近边启发式),
 * 缺"排版后复核":两个相邻不适配块可能同时扩进同一片空白而互相压盖,或
 * 扩展盒以启发式没覆盖到的姿势压住图形/preserve 表格单元。本模块是纯函数
 * 审计:输入已放置块的 当前盒+原始盒、遮挡物与页界,输出违例清单;处置
 * (回退扩展→缩字重试→放弃)由 strictPageReplacement 的 pmGeometryAudit
 * 钩子完成。
 *
 * 关键设计:**只报"新增"的违例**。原始 PDF 几何本身就存在紧贴与轻微重叠
 * (行矩形跨块交叠是常态),按绝对重叠报会淹没在误报里——所以每条规则都以
 * "现在的侵入面积 − 原始盒的侵入面积 > 容差"为准:排版没有让页面变得比
 * 原文更糟,就不算违例。
 *
 * Pure module — no DOM, unit-tested.
 */

import type { PixelBox } from './translatedPageView';

export interface AuditBox {
	id: string;
	/** 当前盒(可能经过算法 3 扩展)。 */
	box: PixelBox;
	/** 构建时的原始盒(扩展前)。 */
	originalBox: PixelBox;
}

export interface LayoutViolation {
	id: string;
	kind: 'overlap' | 'occludes-image' | 'occludes-preserved' | 'out-of-page';
	otherId?: string;
	/** 新增侵入面积 (px²),越页时为越出面积。 */
	area: number;
}

function inter(a: PixelBox, b: PixelBox): number {
	const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
	const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
	return w > 0 && h > 0 ? w * h : 0;
}

function outOfPageArea(box: PixelBox, pageW: number, pageH: number): number {
	const inside: PixelBox = { left: 0, top: 0, width: pageW, height: pageH };
	return Math.max(0, box.width * box.height - inter(box, inside));
}

export interface AuditObstacles {
	images: PixelBox[];
	/** preserve 块/未替换几何块的原始盒(id → 盒)。 */
	preserved: { id: string; box: PixelBox }[];
}

/**
 * 复核已放置的翻译块。容差:新增侵入 > max(12px², 2% × 较小盒面积) 才算
 * 违例——低于它的是渲染取整噪声。返回按新增面积降序(先修最严重的)。
 */
export function auditPlacedBoxes(
	placed: AuditBox[],
	obstacles: AuditObstacles,
	pageW: number,
	pageH: number
): LayoutViolation[] {
	const out: LayoutViolation[] = [];
	const tol = (a: PixelBox, b: PixelBox): number =>
		Math.max(12, 0.02 * Math.min(a.width * a.height, b.width * b.height));
	const growth = (p: AuditBox): number =>
		p.box.width * p.box.height - p.originalBox.width * p.originalBox.height;

	// 1. 翻译块互相压盖:归责给扩展得更多的一方。
	for (let i = 0; i < placed.length; i++) {
		for (let j = i + 1; j < placed.length; j++) {
			const a = placed[i]!;
			const b = placed[j]!;
			const added = inter(a.box, b.box) - inter(a.originalBox, b.originalBox);
			if (added > tol(a.box, b.box)) {
				const offender = growth(a) >= growth(b) ? a : b;
				const other = offender === a ? b : a;
				out.push({ id: offender.id, kind: 'overlap', otherId: other.id, area: added });
			}
		}
	}
	// 2. 压住真实图形(硬规则的排版侧镜像:mask 永不碰图,文本盒也不该)。
	for (const p of placed) {
		for (const img of obstacles.images) {
			const added = inter(p.box, img) - inter(p.originalBox, img);
			if (added > tol(p.box, img)) {
				out.push({ id: p.id, kind: 'occludes-image', area: added });
			}
		}
	}
	// 3. 压住 preserve 区域(数据单元格保留的是原文位图,被盖住 = 数据消失)。
	for (const p of placed) {
		for (const keep of obstacles.preserved) {
			if (keep.id === p.id) {
				continue;
			}
			const added = inter(p.box, keep.box) - inter(p.originalBox, keep.box);
			if (added > tol(p.box, keep.box)) {
				out.push({ id: p.id, kind: 'occludes-preserved', otherId: keep.id, area: added });
			}
		}
	}
	// 4. 越页(扩展本身有 0.9/0.95 页界,这里守的是所有路径的总闸)。
	for (const p of placed) {
		const added = outOfPageArea(p.box, pageW, pageH) - outOfPageArea(p.originalBox, pageW, pageH);
		if (added > 12) {
			out.push({ id: p.id, kind: 'out-of-page', area: added });
		}
	}
	return out.sort((a, b) => b.area - a.area);
}
