/**
 * Стили Cytoscape для ER-canvas.
 *
 * @module webviews/metadataErCanvas/style
 */

import type { StylesheetJson } from 'cytoscape';
import { accentColor, isHighContrast, lineColor, mix, nodeColors, toCss } from './theme';
import type { ErTheme } from './theme';

/** Цвет вида объектов: из него строятся рамка и оттенок заливки узла. */
const TYPE_ACCENTS: readonly (readonly [string, string])[] = [
	['catalog', '#4a8cbf'],
	['document', '#bf4a4a'],
	['informationregister', '#4abf6a'],
	['accumulationregister', '#4abf6a'],
	['accountingregister', '#6abf4a'],
	['calculationregister', '#8abf4a'],
	['enum', '#bfbf4a'],
	['chartofcharacteristictypes', '#8a4abf'],
	['chartofaccounts', '#bf4a8a'],
	['chartofcalculationtypes', '#bf6a4a'],
	['exchangeplan', '#a070ff'],
	['filtercriterion', '#bf8a4a'],
	['functionaloption', '#bf4abf'],
	['functionaloptionsparameter', '#df9f4a'],
	['subsystem', '#888888'],
	['role', '#d98fb0'],
	['commonattribute', '#6a8abf'],
	['businessprocess', '#4abfbf'],
	['task', '#4abfbf'],
	['constant', '#7a7abf'],
	['definedtype', '#7a7abf'],
	['sessionparameter', '#7a7abf'],
	['sequence', '#bf9a4a'],
	['documentjournal', '#bf9a4a'],
	['report', '#c0703a'],
	['dataprocessor', '#c08040'],
	['eventsubscription', '#30b0a0'],
	['scheduledjob', '#30b070'],
	['commoncommand', '#5050c0'],
];

/** Цвет вида связей и его дополнительное оформление. */
const EDGE_ACCENTS: readonly (readonly [string, string, Record<string, string | number>?])[] = [
	['edge.typeComposite, edge.registerDimensionType, edge.registerResourceType', '#4a8cbf', { 'width': 2 }],
	['edge.catalogOwners', '#bf4a4a', { 'target-arrow-shape': 'tee' }],
	['edge.documentPostingRegisters', '#4abf6a', { 'target-arrow-shape': 'circle' }],
	['edge.documentBasedOn', '#bf6060', { 'line-style': 'dashed' }],
	['edge.documentJournalEntries', '#bf9a4a'],
	['edge.sequenceDocuments, edge.sequenceRegisters', '#bf8040'],
	['edge.filterCriterionType, edge.filterCriterionContent', '#8a9a40'],
	['edge.commandParameterType', '#5070bf'],
	['edge.subscriptionSource, edge.subscriptionHandler', '#30a0a0'],
	['edge.scheduledJobHandler', '#30b070', { 'line-style': 'dashed' }],
	['edge.registerChartOfAccounts, edge.registerChartOfCalculationTypes', '#b07040'],
	['edge.chartOfAccountsExtDimensions, edge.characteristicExtValues', '#8060bf'],
	['edge.roleObjectRights', '#d98fb0', { 'line-style': 'dotted', 'width': 1 }],
	['edge.functionalOptionLocation, edge.functionalOptionAffected, edge.fopUseBinding', '#a36ec5'],
	['edge.commonAttributeUsage', '#6a8abf', { 'line-style': 'dashed' }],
	['edge.exchangePlanContent', '#a070ff'],
];

function nodeStyle(accent: string, theme: ErTheme): Record<string, string> {
	const colors = nodeColors(accent, theme);
	return { 'background-color': colors.fill, 'border-color': colors.border, 'color': colors.text };
}

function lineStyle(color: string): Record<string, string> {
	return { 'line-color': color, 'target-arrow-color': color };
}

/**
 * Оформление схемы в цветах темы.
 *
 * @param theme - Цвета текущей темы VS Code
 */
export function buildCytoscapeStyle(theme: ErTheme): StylesheetJson {
	const highContrast = isHighContrast(theme);
	const neutralLine = toCss(lineColor(mix(theme.foreground, theme.background, 0.45), theme));
	return [
		// ── Базовый узел ────────────────────────────────────────────────────
		{
			selector: 'node.md',
			style: {
				...nodeStyle(toCss(theme.muted), theme),
				'border-width': highContrast ? 2 : 1,
				'shape': 'round-rectangle',
				'label': 'data(label)',
				'text-wrap': 'wrap',
				'text-max-width': '200px',
				'text-valign': 'center',
				'text-halign': 'center',
				'font-size': 11,
				'font-family': theme.fontFamily,
				'padding': '10px',
				'width': 'label',
				'height': 'label',
				'min-width': 80,
				'min-height': 40,
			},
		},
		// ── Типовые цвета ──────────────────────────────────────────────────
		...TYPE_ACCENTS.map(([type, accent]) => ({
			selector: `node.md.type-${type}`,
			style: nodeStyle(accent, theme),
		})),
		{
			selector: 'node.md.type-subsystem',
			style: { 'border-style': 'dashed', 'font-style': 'italic' },
		},
		// ── Неполный объект (partial) ──────────────────────────────────────
		{
			selector: 'node.md.partial',
			style: { 'border-style': 'dashed', 'opacity': 0.8 },
		},
		// ── Seed-узел (начальный объект схемы) ─────────────────────────────
		{
			selector: 'node.md.seed',
			style: {
				'border-color': toCss(lineColor(theme.seed, theme)),
				'border-width': highContrast ? 3 : 2,
				'border-style': 'solid',
			},
		},
		// ── Выбранный узел ─────────────────────────────────────────────────
		{
			selector: 'node:selected',
			style: {
				'border-color': toCss(lineColor(theme.selected, theme)),
				'border-width': 3,
				'border-style': 'solid',
			},
		},
		// ── Базовое ребро ──────────────────────────────────────────────────
		{
			selector: 'edge',
			style: {
				...lineStyle(neutralLine),
				'curve-style': 'bezier',
				'target-arrow-shape': 'triangle',
				'arrow-scale': 1,
				'width': 1.5,
				'label': 'data(label)',
				'font-size': 9,
				'font-family': theme.fontFamily,
				'color': toCss(theme.muted),
				'text-background-color': toCss(theme.background),
				'text-background-opacity': 0.9,
				'text-background-padding': '2px',
				'text-rotation': 'none',
				'text-wrap': 'wrap',
				'text-max-width': '180px',
			},
		},
		// ── Виды связей ───────────────────────────────────────────────────
		{
			selector: 'edge.subsystemMembership, edge.subsystemNesting',
			style: { ...lineStyle(neutralLine), 'line-style': 'dashed', 'width': 1 },
		},
		...EDGE_ACCENTS.map(([selector, accent, extra]) => ({
			selector,
			style: { ...lineStyle(toCss(accentColor(accent, theme))), ...extra },
		})),
		{
			selector: 'edge:selected',
			style: { ...lineStyle(toCss(lineColor(theme.selected, theme))), 'width': 3 },
		},
		// ── Подсветка соседства ────────────────────────────────────────────
		{
			selector: '.dimmed',
			style: { 'opacity': 0.12 },
		},
		{
			selector: '.highlighted',
			style: { 'opacity': 1 },
		},
	] as unknown as StylesheetJson;
}
